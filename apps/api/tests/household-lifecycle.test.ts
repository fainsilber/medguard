import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Leaving a household, listing and revoking devices, and deleting a household outright.
 *
 * The same emphasis as auth.test.ts and sync.test.ts: the negative, cross-household cases matter
 * more than the happy path. A device-revocation endpoint that could revoke a device belonging to
 * a different household, or a household-delete that could be triggered against someone else's
 * household, would be a worse bug than not having the feature at all.
 */

const BASE = 'https://example.com/api/v1';
const DEVICES_BASE = 'https://example.com/api/v1/devices';

interface Session {
  deviceToken: string;
  householdId: string;
  userId: string;
  deviceId: string;
}

function authed(session: Session, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.deviceToken}`,
      ...(init.headers ?? {}),
    },
  };
}

async function createHousehold(name = 'Test', displayName = 'Mom'): Promise<Session> {
  const response = await SELF.fetch(`${BASE}/households`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ householdName: name, displayName }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function joinHousehold(session: Session, displayName: string): Promise<Session> {
  const codeResponse = await SELF.fetch(`${BASE}/join-codes`, authed(session, { method: 'POST', body: '{}' }));
  const { code } = (await codeResponse.json()) as { code: string };

  const joinResponse = await SELF.fetch(`${BASE}/join-codes/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, displayName }),
  });
  expect(joinResponse.status).toBe(201);
  return joinResponse.json();
}

async function getMe(session: Session) {
  return SELF.fetch(`${BASE}/me`, authed(session));
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM intake_logs'),
    env.DB.prepare('DELETE FROM medicines'),
    env.DB.prepare('DELETE FROM join_attempts'),
    env.DB.prepare('DELETE FROM join_codes'),
    env.DB.prepare('DELETE FROM devices'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare('DELETE FROM households'),
  ]);
});

describe('POST /leave', () => {
  it('revokes the calling device, so its token stops working on the very next request', async () => {
    const session = await createHousehold();

    const leaveResponse = await SELF.fetch(`${BASE}/leave`, authed(session, { method: 'POST', body: '{}' }));
    expect(leaveResponse.status).toBe(200);

    const after = await getMe(session);
    expect(after.status).toBe(401);
  });

  it('leaving does not affect a second device in the same household', async () => {
    const first = await createHousehold();
    const second = await joinHousehold(first, 'Dad');

    await SELF.fetch(`${BASE}/leave`, authed(first, { method: 'POST', body: '{}' }));

    const secondStillWorks = await getMe(second);
    expect(secondStillWorks.status).toBe(200);
  });

  it('refuses to leave without authentication', async () => {
    const response = await SELF.fetch(`${BASE}/leave`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });
});

describe('GET /devices', () => {
  it('lists every device in the household, flagging which one is the caller', async () => {
    const first = await createHousehold('Test', 'Mom');
    const second = await joinHousehold(first, 'Dad');

    const response = await SELF.fetch(DEVICES_BASE, authed(first));
    const body = (await response.json()) as {
      devices: { id: string; displayName: string; isThisDevice: boolean }[];
    };

    expect(response.status).toBe(200);
    expect(body.devices).toHaveLength(2);

    const mine = body.devices.find((d) => d.id === first.deviceId);
    const theirs = body.devices.find((d) => d.id === second.deviceId);
    expect(mine).toMatchObject({ displayName: 'Mom', isThisDevice: true });
    expect(theirs).toMatchObject({ displayName: 'Dad', isThisDevice: false });
  });

  it('never lists another household\'s devices', async () => {
    const alpha = await createHousehold('Alpha', 'AlphaMom');
    await createHousehold('Beta', 'BetaMom');

    const response = await SELF.fetch(DEVICES_BASE, authed(alpha));
    const body = (await response.json()) as { devices: { displayName: string }[] };

    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({ displayName: 'AlphaMom' });
  });

  it('refuses to list devices without authentication', async () => {
    const response = await SELF.fetch(DEVICES_BASE);
    expect(response.status).toBe(401);
  });
});

describe('DELETE /devices/:id', () => {
  it('revokes a named device, so its token stops working immediately', async () => {
    const first = await createHousehold();
    const second = await joinHousehold(first, 'Dad');

    const response = await SELF.fetch(
      `${DEVICES_BASE}/${second.deviceId}`,
      authed(first, { method: 'DELETE' }),
    );
    expect(response.status).toBe(200);

    const revokedNowFails = await getMe(second);
    expect(revokedNowFails.status).toBe(401);

    // The revoking device's own session is untouched.
    const revokerStillWorks = await getMe(first);
    expect(revokerStillWorks.status).toBe(200);
  });

  it('never lets a caller revoke a device in a different household', async () => {
    const alpha = await createHousehold('Alpha', 'AlphaMom');
    const beta = await createHousehold('Beta', 'BetaMom');

    const response = await SELF.fetch(
      `${DEVICES_BASE}/${beta.deviceId}`,
      authed(alpha, { method: 'DELETE' }),
    );
    expect(response.status).toBe(404);

    // Beta's device is provably still alive — the cross-household attempt did nothing.
    const betaStillWorks = await getMe(beta);
    expect(betaStillWorks.status).toBe(200);
  });

  it('returns 404 for a device id that never existed at all', async () => {
    const session = await createHousehold();
    const response = await SELF.fetch(
      `${DEVICES_BASE}/00000000-0000-4000-8000-000000000000`,
      authed(session, { method: 'DELETE' }),
    );
    expect(response.status).toBe(404);
  });

  it('lets a device revoke itself through this route too', async () => {
    const session = await createHousehold();
    const response = await SELF.fetch(
      `${DEVICES_BASE}/${session.deviceId}`,
      authed(session, { method: 'DELETE' }),
    );
    expect(response.status).toBe(200);

    const after = await getMe(session);
    expect(after.status).toBe(401);
  });
});

describe('DELETE /households', () => {
  it('deletes the household and cascades to its users, devices, and medical records', async () => {
    const session = await createHousehold();
    await SELF.fetch(`${BASE}/sync/push`, authed(session, {
      method: 'POST',
      body: JSON.stringify({
        changes: [
          {
            table: 'medicines',
            record: {
              id: '11111111-1111-4111-8111-111111111111',
              patientId: '00000000-0000-4000-8000-000000000001',
              name: 'Ondansetron',
              strength: '4mg',
              form: 'pill',
              asNeeded: true,
              archived: false,
              updatedAt: '2026-08-03T10:00:00.000Z',
              updatedByDeviceId: session.deviceId,
              syncStatus: 'synced',
            },
          },
        ],
      }),
    }));

    const response = await SELF.fetch(`${BASE}/households`, authed(session, { method: 'DELETE' }));
    expect(response.status).toBe(200);

    const [households, users, devices, medicines] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM households WHERE id = ?').bind(session.householdId).first<{ n: number }>(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE household_id = ?').bind(session.householdId).first<{ n: number }>(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE household_id = ?').bind(session.householdId).first<{ n: number }>(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM medicines WHERE household_id = ?').bind(session.householdId).first<{ n: number }>(),
    ]);

    expect(households?.n).toBe(0);
    expect(users?.n).toBe(0);
    expect(devices?.n).toBe(0);
    expect(medicines?.n).toBe(0);
  });

  it('deleting one household never touches another', async () => {
    const alpha = await createHousehold('Alpha', 'AlphaMom');
    const beta = await createHousehold('Beta', 'BetaMom');

    await SELF.fetch(`${BASE}/households`, authed(alpha, { method: 'DELETE' }));

    const betaHousehold = await env.DB.prepare('SELECT COUNT(*) AS n FROM households WHERE id = ?')
      .bind(beta.householdId)
      .first<{ n: number }>();
    expect(betaHousehold?.n).toBe(1);

    const betaStillWorks = await getMe(beta);
    expect(betaStillWorks.status).toBe(200);
  });

  it('deletes it for every device, not just the one that triggered it — no owner/member distinction', async () => {
    const first = await createHousehold('Test', 'Mom');
    const second = await joinHousehold(first, 'Dad');

    // Dad, not Mom, deletes the household — allowed, since every caregiver is equal here.
    const response = await SELF.fetch(`${BASE}/households`, authed(second, { method: 'DELETE' }));
    expect(response.status).toBe(200);

    const momNowFails = await getMe(first);
    expect(momNowFails.status).toBe(401);
  });

  it('refuses to delete a household without authentication', async () => {
    const response = await SELF.fetch(`${BASE}/households`, { method: 'DELETE' });
    expect(response.status).toBe(401);
  });
});
