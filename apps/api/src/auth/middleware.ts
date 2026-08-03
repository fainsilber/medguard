import { createMiddleware } from 'hono/factory';
import { systemClock } from '@medguard/shared';
import { bearerTokenFrom, hashSecret } from './secrets.js';

/**
 * Resolves a device bearer token to the household it belongs to, and refuses the request if it
 * cannot.
 *
 * Everything downstream reads the household id from here and never from the request body. That is
 * the whole point: if a route took a household id from the client, a caller could ask for someone
 * else's child's medication history simply by changing a field. Because the id is derived from
 * the credential instead, there is no field to change.
 */

export interface AuthenticatedDevice {
  deviceId: string;
  householdId: string;
  userId: string;
}

export type AuthedEnv = {
  Bindings: Env;
  Variables: { auth: AuthenticatedDevice };
};

export const requireDevice = createMiddleware<AuthedEnv>(async (c, next) => {
  const token = bearerTokenFrom(c.req.header('Authorization'));
  if (!token) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  // Looked up by hash rather than compared after fetching: the database only ever holds hashes,
  // and an indexed equality lookup on a 256-bit digest is not a useful timing oracle the way a
  // character-by-character comparison of the raw token would be.
  const row = await c.env.DB.prepare(
    'SELECT id, household_id, user_id FROM devices WHERE token_hash = ?',
  )
    .bind(await hashSecret(token))
    .first<{ id: string; household_id: string; user_id: string }>();

  if (!row) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  c.set('auth', {
    deviceId: row.id,
    householdId: row.household_id,
    userId: row.user_id,
  });

  await next();

  // After the response, so a slow write never delays the caregiver's request. Best-effort: this
  // is diagnostic bookkeeping, and failing it must not fail an otherwise good request.
  c.executionCtx.waitUntil(
    c.env.DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .bind(systemClock.nowIso(), row.id)
      .run()
      .then(
        () => undefined,
        () => undefined,
      ),
  );
});
