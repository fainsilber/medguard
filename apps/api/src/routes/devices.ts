import { Hono } from 'hono';
import { z } from 'zod';
import { systemClock } from '@medguard/shared';
import { requireDevice } from '../auth/middleware.js';
import type { AuthedEnv } from '../auth/middleware.js';
import { readVapidConfig } from '../push/send.js';

/**
 * Listing and revoking devices within the caller's own household.
 *
 * This is what actually closes the "lost or stolen phone" gap: a device token has no expiry, so
 * without a way to invalidate one, a phone that's no longer in a caregiver's hand stays a working
 * credential to a child's medical record forever. Revoking deletes the device row outright rather
 * than marking it inactive — the auth middleware looks a token up by its hash, so a missing row is
 * already indistinguishable from a never-valid one, and there's nothing else worth keeping it for:
 * intake logs and medicines store `logged_by_device_id`/`updated_by_device_id` as plain denormalized
 * text, not a foreign key, so deleting a device never touches the medical history it created.
 */
export const deviceRoutes = new Hono<AuthedEnv>();

deviceRoutes.use('*', requireDevice);

interface DeviceRow {
  id: string;
  platform: string | null;
  created_at: string;
  last_seen_at: string | null;
  user_id: string;
  display_name: string;
}

/** Every device in the caller's household, oldest first, with which one is "this device." */
deviceRoutes.get('/', async (c) => {
  const { householdId, deviceId } = c.get('auth');

  const { results } = await c.env.DB.prepare(
    `SELECT d.id, d.platform, d.created_at, d.last_seen_at, d.user_id, u.display_name
     FROM devices d
     JOIN users u ON u.id = d.user_id
     WHERE d.household_id = ?
     ORDER BY d.created_at`,
  )
    .bind(householdId)
    .all<DeviceRow>();

  return c.json({
    devices: results.map((row) => ({
      id: row.id,
      platform: row.platform,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      userId: row.user_id,
      displayName: row.display_name,
      isThisDevice: row.id === deviceId,
    })),
  });
});

/**
 * Revokes one device. Scoped to the caller's own household in the WHERE clause, not just looked
 * up by id and checked afterward — a caller cannot even discover whether an id belongs to another
 * household, let alone revoke it, which is what a cross-household negative test proves.
 */
deviceRoutes.delete('/:deviceId', async (c) => {
  const { householdId } = c.get('auth');
  const targetDeviceId = c.req.param('deviceId');

  const result = await c.env.DB.prepare('DELETE FROM devices WHERE id = ? AND household_id = ?')
    .bind(targetDeviceId, householdId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ error: 'not_found' }, 404);
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Push registration (Sprint A4, delta AD8)
// ---------------------------------------------------------------------------

/**
 * These three routes replace `POST /api/v1/probe/push`, deleted in this sprint.
 *
 * That route took a caller-supplied subscription endpoint and sent VAPID-signed pushes to it with
 * no authentication at all — an open relay, which also instantiated arbitrary Durable Objects by
 * a caller-supplied id. It was written to answer a Sprint 0 question ("does a push reach a locked
 * phone?"), it answered it on both platforms, and shipping a second client alongside it was not
 * acceptable.
 *
 * The replacement is deliberately narrow: a device registers **its own** credential, and the
 * device id comes from the bearer token rather than from the body, so there is no field to change
 * in order to hijack another caregiver's phone.
 */

const webPushSubscriptionSchema = z.object({
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

const registerPushSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('webpush'), subscription: webPushSubscriptionSchema }),
  // An FCM registration token. Opaque to us — only Google can tell a live one from a dead one,
  // which is what `sendFcm`'s expiry classification is for.
  z.object({ provider: z.literal('fcm'), token: z.string().min(1).max(4096) }),
]);

/**
 * The VAPID public key a browser needs before it can subscribe.
 *
 * Behind device auth, unlike the probe route it replaces. The key is public by nature — it is
 * handed to every push service — so this is not about secrecy; it is about not offering an
 * unauthenticated surface that tells a stranger this deployment exists and is configured.
 */
deviceRoutes.get('/push/vapid-public-key', (c) => {
  const vapid = readVapidConfig(c.env);
  if (!vapid) {
    return c.json({ error: 'vapid_not_configured' }, 503);
  }
  return c.json({ publicKey: vapid.publicKey });
});

/**
 * Registers (or re-registers) this device's push credential.
 *
 * Idempotent by design: browsers rotate subscriptions and Android rotates FCM tokens without
 * asking, so clients call this on every start. Registering also arms the household's alarm chain,
 * which matters for a household that has not written anything since the chain was deployed —
 * otherwise its first alarm would wait for an unrelated sync write.
 */
deviceRoutes.post('/push', async (c) => {
  const { householdId, deviceId } = c.get('auth');

  const parsed = registerPushSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const credentials =
    parsed.data.provider === 'webpush'
      ? JSON.stringify(parsed.data.subscription)
      : parsed.data.token;

  await c.env.DB.prepare(
    `UPDATE devices
        SET push_provider = ?, push_credentials = ?, last_seen_at = ?
      WHERE id = ? AND household_id = ?`,
  )
    .bind(parsed.data.provider, credentials, systemClock.nowIso(), deviceId, householdId)
    .run();

  const stub = c.env.HOUSEHOLD.get(c.env.HOUSEHOLD.idFromName(householdId));
  await stub.ensureAlarmsArmed(householdId);

  return c.json({ ok: true, provider: parsed.data.provider });
});

/**
 * Stops sending push to this device, without signing it out.
 *
 * A caregiver turning notifications off is not a caregiver giving up their access to a child's
 * medical record — the same distinction `dispatch.ts` makes when it prunes a dead credential.
 */
deviceRoutes.delete('/push', async (c) => {
  const { householdId, deviceId } = c.get('auth');

  await c.env.DB.prepare(
    'UPDATE devices SET push_credentials = NULL WHERE id = ? AND household_id = ?',
  )
    .bind(deviceId, householdId)
    .run();

  return c.json({ ok: true });
});
