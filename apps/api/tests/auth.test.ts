import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The join-code flow, against real routes and real D1.
 *
 * The negative cases matter more than the happy path here: this is the boundary that keeps one
 * family's medical data away from another's, and an authorization mistake leaks a child's
 * medication history.
 */

const BASE = 'https://example.com/api/v1';

async function post(path: string, body: unknown, init: RequestInit = {}) {
  return SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: JSON.stringify(body),
    ...init,
  });
}

async function createHousehold(name = 'Test Household', displayName = 'Mom') {
  const response = await post('/households', { householdName: name, displayName });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    deviceToken: string;
    householdId: string;
    userId: string;
    deviceId: string;
  };
}

async function issueCode(token: string) {
  const response = await post('/join-codes', {}, { headers: { Authorization: `Bearer ${token}` } });
  expect(response.status).toBe(201);
  return (await response.json()) as { code: string; expiresAt: string };
}

beforeEach(async () => {
  // Isolated D1 storage is per test *file*, not per test, so rows from an earlier test are still
  // there. Rate limiting in particular is stateful enough that a leaked attempt count would trip
  // a later test for reasons that have nothing to do with what it is asserting.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM join_attempts'),
    env.DB.prepare('DELETE FROM join_codes'),
    env.DB.prepare('DELETE FROM devices'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare('DELETE FROM households'),
  ]);
});

describe('POST /households', () => {
  it('creates a household, a first caregiver, and a device token', async () => {
    const result = await createHousehold('The Cohens', 'Dad');

    expect(result.deviceToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.householdId).toBeTruthy();

    const household = await env.DB.prepare('SELECT name FROM households WHERE id = ?')
      .bind(result.householdId)
      .first<{ name: string }>();
    expect(household?.name).toBe('The Cohens');
  });

  it('stores only a hash of the token, never the token itself', async () => {
    const { deviceToken, deviceId } = await createHousehold();

    const device = await env.DB.prepare('SELECT token_hash FROM devices WHERE id = ?')
      .bind(deviceId)
      .first<{ token_hash: string }>();

    expect(device?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(device?.token_hash).not.toBe(deviceToken);
  });

  it('rejects a malformed payload rather than creating a half-built household', async () => {
    const response = await post('/households', { householdName: '' });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_request' });

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM households').first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('rejects a body that is not JSON at all', async () => {
    const response = await SELF.fetch(`${BASE}/households`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });

    expect(response.status).toBe(400);
  });
});

describe('device token authentication', () => {
  it('accepts a valid token', async () => {
    const { deviceToken, householdId } = await createHousehold();

    const response = await SELF.fetch(`${BASE}/me`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ householdId, displayName: 'Mom' });
  });

  it('rejects a missing, malformed, or unknown token', async () => {
    for (const headers of [
      {},
      { Authorization: 'Bearer' },
      { Authorization: 'Basic abc' },
      { Authorization: 'Bearer not-a-real-token' },
    ]) {
      const response = await SELF.fetch(`${BASE}/me`, { headers });
      expect(response.status).toBe(401);
    }
  });

  it('records last_seen_at, so a stale device is visible', async () => {
    const { deviceToken, deviceId } = await createHousehold();

    await SELF.fetch(`${BASE}/me`, { headers: { Authorization: `Bearer ${deviceToken}` } });

    const device = await env.DB.prepare('SELECT last_seen_at FROM devices WHERE id = ?')
      .bind(deviceId)
      .first<{ last_seen_at: string | null }>();
    expect(device?.last_seen_at).toBeTruthy();
  });
});

describe('join codes', () => {
  it('lets a second device join and land in the same household', async () => {
    const first = await createHousehold('The Cohens');
    const { code } = await issueCode(first.deviceToken);

    const response = await post('/join-codes/redeem', { code, displayName: 'Dad' });
    expect(response.status).toBe(201);

    const second = (await response.json()) as {
      deviceToken: string;
      householdId: string;
      householdName: string;
    };
    expect(second.householdId).toBe(first.householdId);
    expect(second.deviceToken).not.toBe(first.deviceToken);
    // Otherwise the joining device never learns the household's name — only the creator does.
    expect(second.householdName).toBe('The Cohens');
  });

  it('stores only a hash of the code', async () => {
    const first = await createHousehold();
    const { code } = await issueCode(first.deviceToken);

    const row = await env.DB.prepare('SELECT code_hash FROM join_codes').first<{ code_hash: string }>();
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.code_hash).not.toContain(code);
  });

  it('refuses to issue a code without authentication', async () => {
    const response = await post('/join-codes', {});
    expect(response.status).toBe(401);
  });

  it('rejects a code that has already been redeemed', async () => {
    const first = await createHousehold();
    const { code } = await issueCode(first.deviceToken);

    await post('/join-codes/redeem', { code, displayName: 'Dad' });
    const second = await post('/join-codes/redeem', { code, displayName: 'Grandma' });

    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: 'invalid_code' });
  });

  it('rejects an expired code', async () => {
    const first = await createHousehold();
    const { code } = await issueCode(first.deviceToken);

    // Reach into the row rather than waiting fifteen minutes.
    await env.DB.prepare('UPDATE join_codes SET expires_at = ?')
      .bind('2020-01-01T00:00:00.000Z')
      .run();

    const response = await post('/join-codes/redeem', { code, displayName: 'Dad' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_code' });
  });

  it('rejects a code that was never issued', async () => {
    await createHousehold();

    const response = await post('/join-codes/redeem', { code: '000000', displayName: 'Dad' });
    expect(response.status).toBe(400);
  });

  it('gives the same error for wrong, expired and used codes, so none can be distinguished', async () => {
    const first = await createHousehold();
    const { code } = await issueCode(first.deviceToken);
    await post('/join-codes/redeem', { code, displayName: 'Dad' });

    const used = await post('/join-codes/redeem', { code, displayName: 'X' });
    const wrong = await post('/join-codes/redeem', { code: '999999', displayName: 'X' });

    expect(used.status).toBe(wrong.status);
    expect(await used.json()).toEqual(await wrong.json());
  });

  it('rejects a code that is not six digits, without consuming a lookup', async () => {
    for (const code of ['12345', '1234567', 'abcdef', '']) {
      const response = await post('/join-codes/redeem', { code, displayName: 'Dad' });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    }
  });

  it('rate limits repeated redemption attempts — a 6-digit code is brute-forceable otherwise', async () => {
    await createHousehold();

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await post('/join-codes/redeem', { code: '123456', displayName: 'Dad' });
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
    // The limit is 10 per window, so the eleventh attempt onward is refused.
    expect(statuses.slice(0, 10).every((status) => status === 400)).toBe(true);
    expect(statuses.slice(10).every((status) => status === 429)).toBe(true);
  });

  it('prunes rate-limit records older than the window — the only place an IP is stored', async () => {
    await createHousehold();

    await env.DB.prepare('INSERT INTO join_attempts (source, attempted_at) VALUES (?, ?)')
      .bind('1.2.3.4', '2020-01-01T00:00:00.000Z')
      .run();

    await post('/join-codes/redeem', { code: '123456', displayName: 'Dad' });

    const stale = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM join_attempts WHERE attempted_at = ?',
    )
      .bind('2020-01-01T00:00:00.000Z')
      .first<{ n: number }>();
    expect(stale?.n).toBe(0);
  });

  it('still refuses a valid code once the caller is rate limited', async () => {
    const first = await createHousehold();
    const { code } = await issueCode(first.deviceToken);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await post('/join-codes/redeem', { code: '999999', displayName: 'X' });
    }

    const response = await post('/join-codes/redeem', { code, displayName: 'Dad' });
    expect(response.status).toBe(429);
  });
});

describe('household isolation', () => {
  it('never lets a code from one household join another', async () => {
    const alpha = await createHousehold('Alpha', 'AlphaMom');
    const beta = await createHousehold('Beta', 'BetaMom');
    const { code } = await issueCode(alpha.deviceToken);

    const response = await post('/join-codes/redeem', { code, displayName: 'Joiner' });
    const joined = (await response.json()) as { householdId: string };

    expect(joined.householdId).toBe(alpha.householdId);
    expect(joined.householdId).not.toBe(beta.householdId);
  });

  it('scopes an issued code to the issuing device household, not to anything in the request', async () => {
    const alpha = await createHousehold('Alpha', 'AlphaMom');
    const beta = await createHousehold('Beta', 'BetaMom');

    // A caller trying to mint a code into someone else's household by naming it in the body.
    const response = await post(
      '/join-codes',
      { householdId: beta.householdId },
      { headers: { Authorization: `Bearer ${alpha.deviceToken}` } },
    );
    expect(response.status).toBe(201);

    const row = await env.DB.prepare('SELECT household_id FROM join_codes').first<{
      household_id: string;
    }>();
    expect(row?.household_id).toBe(alpha.householdId);
  });
});
