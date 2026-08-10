import { PUSH_CHANNEL_IDS, describePush } from '@medguard/shared';
import type { PushPayload } from '@medguard/shared';
import { readFcmConfig, sendFcm } from './fcm.js';
import { readVapidConfig, sendPush } from './send.js';
import type { PushResult, PushSubscription } from './send.js';

/**
 * One entry point for "tell this household something", whatever kind of device each caregiver
 * carries.
 *
 * Everything above this line — the dose chain, escalation, low stock, and A5's Shabbat fan-out —
 * is provider-blind. That is the whole point: a household is a mix of a phone running the native
 * client and a phone or laptop running the PWA, and the escalation logic must not have to care.
 * Below this line there are exactly two transports, and they are already the same shape
 * (`PushResult`), so the only real work here is picking one and pruning what turns out to be dead.
 */

export type DispatchSkipReason =
  /** The device never registered a push credential — a browser that declined permission. */
  | 'no_credentials'
  /** Registered, but the transport it needs isn't configured on this Worker. */
  | 'provider_not_configured'
  /** The stored credential could not be parsed back into something sendable. */
  | 'invalid_credentials';

export interface DispatchResult {
  deviceId: string;
  provider: 'webpush' | 'fcm';
  ok: boolean;
  status: number;
  error?: string;
  /** Set when nothing was sent at all, which is not the same failure as a send that was refused. */
  skipped?: DispatchSkipReason;
  /** The credential was dead and has been cleared; the device stays, only its push does not. */
  pruned?: boolean;
}

export interface DispatchOptions {
  /** Restrict to these device ids. Absent means the whole household. */
  only?: readonly string[];
  /** Skip these device ids — e.g. the device that already knows, on a targeted first alert. */
  exclude?: readonly string[];
  /**
   * How long a push service may hold the message for a sleeping device. A dose alert that
   * surfaces an hour late is worse than one that never arrives: it invites a second dose.
   */
  ttlSeconds?: number;
}

interface DeviceRow extends Record<string, unknown> {
  id: string;
  push_provider: 'webpush' | 'fcm';
  push_credentials: string | null;
}

/**
 * The FCM data map.
 *
 * `payload` is the whole typed record, so a native client that shares `@medguard/shared` parses
 * exactly what the web client receives. `title`/`body`/`channelId` are lifted out beside it
 * because `MedGuardMessagingService` is Kotlin and cannot call `describePush` — this way the
 * wording still has exactly one definition (delta AD2's rule, applied to notification text rather
 * than to the ledger).
 *
 * Every value must be a string: FCM's `data` is `map<string, string>`, and a number silently
 * fails the whole send.
 */
function fcmDataFor(payload: PushPayload): Record<string, string> {
  const { title, body } = describePush(payload);
  return {
    payload: JSON.stringify(payload),
    kind: payload.kind,
    channelId: PUSH_CHANNEL_IDS[payload.kind],
    title,
    body,
    ...('occurrenceId' in payload ? { occurrenceId: payload.occurrenceId } : {}),
  };
}

function parseSubscription(raw: string): PushSubscription | null {
  try {
    const parsed = JSON.parse(raw) as Partial<PushSubscription>;
    if (
      typeof parsed.endpoint === 'string' &&
      typeof parsed.keys?.auth === 'string' &&
      typeof parsed.keys?.p256dh === 'string'
    ) {
      return { endpoint: parsed.endpoint, keys: parsed.keys };
    }
  } catch {
    // Falls through to null — a credential we can't parse is dead, not fatal.
  }
  return null;
}

/**
 * Clears a dead credential without touching the device row.
 *
 * Deliberately *not* `DELETE FROM devices`: that row is the caregiver's auth credential
 * (`auth/middleware.ts` resolves a bearer token to it), so deleting it because a browser rotated
 * a push subscription would silently sign someone out of their child's medical record. The device
 * stays authenticated and simply stops being reachable by push until it re-registers.
 */
async function pruneCredentials(env: Env, householdId: string, deviceId: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE devices SET push_credentials = NULL WHERE id = ? AND household_id = ?',
  )
    .bind(deviceId, householdId)
    .run();
}

/**
 * Sends one payload to every registered device in a household.
 *
 * Sends are issued concurrently: a household with three devices should not wait for a slow push
 * service to time out before the second caregiver's phone is even attempted, and on an escalation
 * that latency is the entire product.
 *
 * One message per device per call. The Shabbat burst — several pushes ~1.1s apart, approximating
 * a 45-second chime out of what a browser can actually deliver — is a *schedule*, not a fan-out,
 * so it belongs to the caller's alarm chain (Sprint A5) rather than here.
 */
export async function dispatchToHousehold(
  env: Env,
  householdId: string,
  payload: PushPayload,
  options: DispatchOptions = {},
): Promise<DispatchResult[]> {
  const { results: devices } = await env.DB.prepare(
    'SELECT id, push_provider, push_credentials FROM devices WHERE household_id = ? ORDER BY created_at',
  )
    .bind(householdId)
    .all<DeviceRow>();

  const only = options.only ? new Set(options.only) : null;
  const exclude = new Set(options.exclude ?? []);

  const targets = devices.filter(
    (device) => !exclude.has(device.id) && (only === null || only.has(device.id)),
  );

  const vapid = readVapidConfig(env);
  const fcm = readFcmConfig(env);
  const body = fcmDataFor(payload);
  const ttl = options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds };

  return Promise.all(
    targets.map(async (device): Promise<DispatchResult> => {
      const base = { deviceId: device.id, provider: device.push_provider };

      if (!device.push_credentials) {
        return { ...base, ok: false, status: 0, skipped: 'no_credentials' };
      }

      let result: PushResult;

      if (device.push_provider === 'fcm') {
        if (!fcm) {
          return { ...base, ok: false, status: 0, skipped: 'provider_not_configured' };
        }
        result = await sendFcm(device.push_credentials, body, fcm, ttl);
      } else {
        if (!vapid) {
          return { ...base, ok: false, status: 0, skipped: 'provider_not_configured' };
        }
        const subscription = parseSubscription(device.push_credentials);
        if (!subscription) {
          await pruneCredentials(env, householdId, device.id);
          return { ...base, ok: false, status: 0, skipped: 'invalid_credentials', pruned: true };
        }
        result = await sendPush(subscription, payload, vapid, { ...ttl, urgency: 'high' });
      }

      if (result.ok) {
        return { ...base, ok: true, status: result.status };
      }

      if (result.expired) {
        await pruneCredentials(env, householdId, device.id);
      }

      return {
        ...base,
        ok: false,
        status: result.status,
        error: result.error,
        ...(result.expired ? { pruned: true } : {}),
      };
    }),
  );
}
