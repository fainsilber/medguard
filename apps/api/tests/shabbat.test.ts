import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SINGLE_PATIENT_ID, toIso } from '@medguard/shared';
import type { ShabbatWindow } from '@medguard/shared';

/**
 * `GET /api/v1/shabbat/zmanim` — the server-computed zmanim behind the Sprint 6 verification
 * screen. See `packages/shared/src/shabbat.test.ts` for the computation itself; this file only
 * proves the route reads the right household's config and reports honestly when it can't.
 */

const BASE = 'https://example.com/api/v1';

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

async function createHousehold(): Promise<Session> {
  const response = await SELF.fetch(`${BASE}/households`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ householdName: 'Test', displayName: 'Mom' }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function push(session: Session, changes: { table: string; record: unknown }[]) {
  const response = await SELF.fetch(
    `${BASE}/sync/push`,
    authed(session, { method: 'POST', body: JSON.stringify({ changes }) }),
  );
  expect(response.status).toBe(200);
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'household',
    timeZone: 'Asia/Jerusalem',
    escalationAfterMinutes: 15,
    snoozeMinutes: 20,
    updatedAt: toIso(Date.now()),
    updatedByDeviceId: 'device',
    syncStatus: 'synced',
    ...overrides,
  };
}

function shabbatConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    patientId: SINGLE_PATIENT_ID,
    autoShabbatEnabled: false,
    latitude: 31.7683,
    longitude: 35.2137,
    candleLightingOffsetMins: 18,
    havdalahDegreesOrMins: '8.5_degrees',
    israelHolidays: true,
    chimeDurationSeconds: 45,
    updatedAt: toIso(Date.now()),
    updatedByDeviceId: 'device',
    syncStatus: 'synced',
    ...overrides,
  };
}

async function getZmanim(session: Session, query = '') {
  return SELF.fetch(`${BASE}/shabbat/zmanim${query}`, authed(session));
}

describe('GET /shabbat/zmanim', () => {
  it('rejects a request with no device token', async () => {
    const response = await SELF.fetch(`${BASE}/shabbat/zmanim`);
    expect(response.status).toBe(401);
  });

  it('reports not configured when the household has not synced a timezone yet', async () => {
    const session = await createHousehold();

    const response = await getZmanim(session);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, reason: 'no_timezone', windows: [] });
  });

  it('reports not configured when the household has a timezone but no Shabbat config', async () => {
    const session = await createHousehold();
    await push(session, [{ table: 'householdSettings', record: settings() }]);

    const response = await getZmanim(session);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: false,
      reason: 'no_shabbat_config',
      windows: [],
    });
  });

  it('returns computed windows once both are synced, even with auto-Shabbat off', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'shabbatConfig', record: shabbatConfig({ autoShabbatEnabled: false }) },
    ]);

    const response = await getZmanim(session);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      configured: true;
      autoShabbatEnabled: boolean;
      timeZone: string;
      windows: ShabbatWindow[];
    };
    expect(body.configured).toBe(true);
    expect(body.autoShabbatEnabled).toBe(false);
    expect(body.timeZone).toBe('Asia/Jerusalem');
    // Eight default weeks always contains at least one real Shabbat, wherever "now" is.
    expect(body.windows.length).toBeGreaterThan(0);
    for (const window of body.windows) {
      expect(new Date(window.startsAt).getTime()).toBeLessThan(new Date(window.endsAt).getTime());
    }
  });

  it('clamps an out-of-range weeks parameter rather than doing unbounded work', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'shabbatConfig', record: shabbatConfig() },
    ]);

    const oneWeek = (await (await getZmanim(session, '?weeks=1')).json()) as { windows: ShabbatWindow[] };
    const tooMany = (await (await getZmanim(session, '?weeks=999')).json()) as { windows: ShabbatWindow[] };

    expect(oneWeek.windows.length).toBeLessThanOrEqual(tooMany.windows.length);
  });

  it('never returns another household’s Shabbat config', async () => {
    const mine = await createHousehold();
    const theirs = await createHousehold();
    await push(theirs, [
      { table: 'householdSettings', record: settings({ timeZone: 'America/New_York' }) },
      { table: 'shabbatConfig', record: shabbatConfig({ latitude: 40.7128, longitude: -74.006 }) },
    ]);

    const response = await getZmanim(mine);
    expect(await response.json()).toEqual({ configured: false, reason: 'no_timezone', windows: [] });
  });
});
