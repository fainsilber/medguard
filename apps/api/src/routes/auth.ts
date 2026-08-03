import { Hono } from 'hono';
import { z } from 'zod';
import { systemClock, uuidIdGenerator } from '@medguard/shared';
import {
  generateDeviceToken,
  generateJoinCode,
  hashSecret,
} from '../auth/secrets.js';
import { requireDevice } from '../auth/middleware.js';
import type { AuthedEnv } from '../auth/middleware.js';

/**
 * Household creation and the join-code flow.
 *
 * There is no password anywhere in this system. A caregiver creates a household on their phone,
 * reads a 6-digit code to the other caregiver, and that second device exchanges the code for a
 * long-lived token. Everything after that is the token.
 *
 * A 6-digit code is only a million possibilities, so it is defended three ways at once — short
 * lifetime, single use, and rate-limited redemption. Any one alone would not be enough.
 */

/** Long enough to walk across a ward and read it out; short enough that a stale code is useless. */
const JOIN_CODE_TTL_MS = 15 * 60_000;

/** Redemption attempts allowed from one source per window. */
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;

export const authRoutes = new Hono<AuthedEnv>();

const createHouseholdSchema = z.object({
  householdName: z.string().min(1).max(100),
  displayName: z.string().min(1).max(100),
  platform: z.string().max(50).optional(),
});

const redeemSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'a join code is six digits'),
  displayName: z.string().min(1).max(100),
  platform: z.string().max(50).optional(),
});

/**
 * Identifies the caller for rate limiting. `CF-Connecting-IP` is set by Cloudflare's edge and
 * cannot be spoofed by the client the way a forwarded header can.
 *
 * Falling back to a shared bucket when the header is absent (local dev, tests) is deliberate: a
 * missing header must make the limit stricter, never disable it.
 */
function rateLimitSource(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('CF-Connecting-IP') ?? 'unknown-source';
}

async function isRateLimited(db: D1Database, source: string, nowMs: number): Promise<boolean> {
  const windowStart = new Date(nowMs - RATE_LIMIT_WINDOW_MS).toISOString();

  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM join_attempts WHERE source = ? AND attempted_at > ?')
    .bind(source, windowStart)
    .first<{ n: number }>();

  return (row?.n ?? 0) >= RATE_LIMIT_MAX_ATTEMPTS;
}

async function recordAttempt(
  db: D1Database,
  source: string,
  nowIso: string,
  nowMs: number,
): Promise<void> {
  const windowStart = new Date(nowMs - RATE_LIMIT_WINDOW_MS).toISOString();

  await db.batch([
    db.prepare('INSERT INTO join_attempts (source, attempted_at) VALUES (?, ?)').bind(source, nowIso),
    // Pruned on every write rather than left to accumulate. This table exists solely to enforce a
    // ten-minute window, and an IP address older than that window serves no purpose — keeping it
    // would make this the one place the system quietly retains identifying data forever.
    db.prepare('DELETE FROM join_attempts WHERE attempted_at <= ?').bind(windowStart),
  ]);
}

/**
 * Creates a household and its first caregiver, returning a device token.
 *
 * Deliberately unauthenticated — it is the one entry point that has to be, because there is no
 * credential yet. It creates only an empty household, so the worst an abuser achieves is junk
 * rows; no existing household can be reached or affected through it.
 */
authRoutes.post('/households', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createHouseholdSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const nowIso = systemClock.nowIso();
  const householdId = uuidIdGenerator.next();
  const userId = uuidIdGenerator.next();
  const deviceId = uuidIdGenerator.next();
  const token = generateDeviceToken();

  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)').bind(
      householdId,
      parsed.data.householdName,
      nowIso,
    ),
    c.env.DB.prepare(
      'INSERT INTO users (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)',
    ).bind(userId, householdId, parsed.data.displayName, nowIso),
    c.env.DB.prepare(
      `INSERT INTO devices (id, household_id, user_id, token_hash, platform, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(deviceId, householdId, userId, await hashSecret(token), parsed.data.platform ?? null, nowIso),
  ]);

  return c.json(
    {
      // The only time the token is ever transmitted. It is not recoverable afterwards — the
      // server keeps a hash, so a device that loses it has to rejoin with a new code.
      deviceToken: token,
      householdId,
      userId,
      deviceId,
    },
    201,
  );
});

/** Issues a join code for the caller's own household. Scoped by the token, never by a body field. */
authRoutes.post('/join-codes', requireDevice, async (c) => {
  const { householdId, userId } = c.get('auth');

  const nowMs = systemClock.nowMs();
  const code = generateJoinCode();

  await c.env.DB.prepare(
    `INSERT INTO join_codes (code_hash, household_id, created_by_user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      await hashSecret(code),
      householdId,
      userId,
      new Date(nowMs).toISOString(),
      new Date(nowMs + JOIN_CODE_TTL_MS).toISOString(),
    )
    .run();

  return c.json(
    {
      code,
      expiresAt: new Date(nowMs + JOIN_CODE_TTL_MS).toISOString(),
      expiresInSeconds: Math.floor(JOIN_CODE_TTL_MS / 1000),
    },
    201,
  );
});

/**
 * Exchanges a join code for a device token.
 *
 * Every failure mode returns the same `invalid_code` error — wrong, expired, and already-redeemed
 * are indistinguishable to the caller. Telling someone which of those it was would confirm that a
 * code exists, which is exactly the signal a brute-force attempt needs.
 */
authRoutes.post('/join-codes/redeem', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = redeemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const source = rateLimitSource(c);
  const nowMs = systemClock.nowMs();
  const nowIso = new Date(nowMs).toISOString();

  if (await isRateLimited(c.env.DB, source, nowMs)) {
    return c.json({ error: 'too_many_attempts' }, 429);
  }
  // Recorded before the lookup, so an attempt counts even if the request dies partway through.
  await recordAttempt(c.env.DB, source, nowIso, nowMs);

  const codeRow = await c.env.DB.prepare(
    `SELECT jc.code_hash, jc.household_id, jc.expires_at, jc.redeemed_at, h.name AS household_name
     FROM join_codes jc
     JOIN households h ON h.id = jc.household_id
     WHERE jc.code_hash = ?`,
  )
    .bind(await hashSecret(parsed.data.code))
    .first<{
      code_hash: string;
      household_id: string;
      expires_at: string;
      redeemed_at: string | null;
      household_name: string;
    }>();

  if (!codeRow || codeRow.redeemed_at !== null || codeRow.expires_at <= nowIso) {
    return c.json({ error: 'invalid_code' }, 400);
  }

  const userId = uuidIdGenerator.next();
  const deviceId = uuidIdGenerator.next();
  const token = generateDeviceToken();

  // The conditional UPDATE is what actually enforces single use: two devices redeeming the same
  // code simultaneously both pass the check above, but only one can match `redeemed_at IS NULL`.
  const claim = await c.env.DB.prepare(
    'UPDATE join_codes SET redeemed_at = ?, redeemed_by_device = ? WHERE code_hash = ? AND redeemed_at IS NULL',
  )
    .bind(nowIso, deviceId, codeRow.code_hash)
    .run();

  if (claim.meta.changes === 0) {
    return c.json({ error: 'invalid_code' }, 400);
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO users (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)',
    ).bind(userId, codeRow.household_id, parsed.data.displayName, nowIso),
    c.env.DB.prepare(
      `INSERT INTO devices (id, household_id, user_id, token_hash, platform, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      deviceId,
      codeRow.household_id,
      userId,
      await hashSecret(token),
      parsed.data.platform ?? null,
      nowIso,
    ),
  ]);

  return c.json(
    {
      deviceToken: token,
      householdId: codeRow.household_id,
      householdName: codeRow.household_name,
      userId,
      deviceId,
    },
    201,
  );
});

/** Who am I — lets a client confirm a stored token is still valid on startup. */
authRoutes.get('/me', requireDevice, async (c) => {
  const { householdId, userId, deviceId } = c.get('auth');

  const household = await c.env.DB.prepare('SELECT name FROM households WHERE id = ?')
    .bind(householdId)
    .first<{ name: string }>();
  const user = await c.env.DB.prepare('SELECT display_name FROM users WHERE id = ?')
    .bind(userId)
    .first<{ display_name: string }>();

  return c.json({
    householdId,
    householdName: household?.name ?? null,
    userId,
    displayName: user?.display_name ?? null,
    deviceId,
  });
});

/**
 * Revokes the calling device's own token — the server-side half of "sign out." A caregiver's
 * local sign-out clears the token from this device, but the token itself would otherwise stay
 * valid indefinitely (delta from docs/data-handling.md's biggest known gap): anyone who somehow
 * retained a copy of it could keep using it. This makes the token genuinely dead, not just
 * locally forgotten.
 */
authRoutes.post('/leave', requireDevice, async (c) => {
  const { deviceId } = c.get('auth');
  await c.env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(deviceId).run();
  return c.json({ ok: true });
});

/**
 * Deletes the caller's own household — every user, device, and medical record in it, for every
 * caregiver, permanently. There is no owner/member distinction anywhere in this schema (every
 * caregiver already sees and can log everything equally — docs/data-handling.md), so any
 * authenticated member of the household may do this; it is not restricted to whoever created it.
 *
 * Scoped entirely from the token, like every other route here — there is no household id in the
 * request for a caller to substitute someone else's household into.
 */
authRoutes.delete('/households', requireDevice, async (c) => {
  const { householdId } = c.get('auth');
  await c.env.DB.prepare('DELETE FROM households WHERE id = ?').bind(householdId).run();
  return c.json({ ok: true });
});
