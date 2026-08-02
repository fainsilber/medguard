import { decodeBase64Url } from './base64url.js';
import { encryptPayload } from './encrypt.js';
import { createVapidAuthorization } from './vapid.js';
import type { VapidConfig } from './vapid.js';

/**
 * Web Push over VAPID, WebCrypto only — no Node crypto, so it runs on workerd.
 *
 * Uses RFC 8291 `aes128gcm`. The npm WebCrypto push libraries all still emit the legacy
 * `aesgcm` scheme, which Apple's APNs rejects outright; see encrypt.ts.
 */

export type { VapidConfig } from './vapid.js';

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export type PushResult =
  | { ok: true; status: number }
  /**
   * `expired` distinguishes a dead subscription (the browser rotated or revoked it) from a
   * transient failure. Sprint 5 deletes those rows rather than retrying them forever.
   */
  | { ok: false; status: number; error: string; expired: boolean };

export function readVapidConfig(env: Env): VapidConfig | null {
  const { VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = env;
  if (!VAPID_SUBJECT || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return null;
  }
  return { subject: VAPID_SUBJECT, publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
}

export async function sendPush(
  subscription: PushSubscription,
  payload: unknown,
  vapid: VapidConfig,
  options: { ttlSeconds?: number; urgency?: 'low' | 'normal' | 'high' } = {},
): Promise<PushResult> {
  const { body } = await encryptPayload(new TextEncoder().encode(JSON.stringify(payload)), {
    p256dh: decodeBase64Url(subscription.keys.p256dh),
    auth: decodeBase64Url(subscription.keys.auth),
  });

  let response: Response;
  try {
    response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization: await createVapidAuthorization(subscription.endpoint, vapid),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(options.ttlSeconds ?? 60),
        urgency: options.urgency ?? 'high',
      },
      body,
    });
  } catch (cause) {
    return {
      ok: false,
      status: 0,
      error: cause instanceof Error ? cause.message : 'network error',
      expired: false,
    };
  }

  if (response.ok) {
    return { ok: true, status: response.status };
  }

  return {
    ok: false,
    status: response.status,
    error: (await response.text().catch(() => '')) || response.statusText,
    // 404 Not Found / 410 Gone are the push services' way of saying the subscription is dead.
    expired: response.status === 404 || response.status === 410,
  };
}
