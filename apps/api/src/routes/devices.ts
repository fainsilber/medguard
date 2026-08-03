import { Hono } from 'hono';
import { requireDevice } from '../auth/middleware.js';
import type { AuthedEnv } from '../auth/middleware.js';

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
