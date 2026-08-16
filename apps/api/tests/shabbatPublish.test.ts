import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SINGLE_PATIENT_ID, fromIso, toIso } from '@medguard/shared';
import {
  PUBLISH_HORIZON_MS,
  furthestPublishedMs,
  publishWindows,
  publishWindowsIfStale,
} from '../src/shabbat/publish.js';

/**
 * Publishing Shabbat windows into a household's synced data (Sprint A5).
 *
 * What matters here is not the times themselves — `zmanim.test.ts` owns those — but that the
 * windows reach devices through the ordinary sync path, that republishing is idempotent rather
 * than duplicating, and that a household missing its coordinates or its timezone publishes
 * nothing at all instead of publishing something computed from a guess.
 */

const BASE = 'https://example.com/api/v1';
const NOW_MS = fromIso('2026-08-13T09:00:00.000Z');

interface Session {
  deviceToken: string;
  householdId: string;
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

async function push(session: Session, changes: { table: string; record: unknown }[]) {
  const response = await SELF.fetch(
    `${BASE}/sync/push`,
    authed(session, { method: 'POST', body: JSON.stringify({ changes }) }),
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{ rejected: { table: string }[] }>;
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'household',
    timeZone: 'Asia/Jerusalem',
    escalationAfterMinutes: 15,
    snoozeMinutes: 20,
    updatedAt: toIso(NOW_MS),
    updatedByDeviceId: 'device',
    syncStatus: 'synced',
    ...overrides,
  };
}

function shabbatConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    patientId: SINGLE_PATIENT_ID,
    autoShabbatEnabled: true,
    latitude: 31.7683,
    longitude: 35.2137,
    candleLightingOffsetMins: 18,
    havdalahDegreesOrMins: '8.5_degrees',
    israelHolidays: true,
    chimeDurationSeconds: 30,
    weekdayChimeDurationSeconds: 60,
    updatedAt: toIso(NOW_MS),
    updatedByDeviceId: 'device',
    syncStatus: 'synced',
    ...overrides,
  };
}

async function countWindows(householdId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM shabbat_windows WHERE household_id = ?',
  )
    .bind(householdId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe('publishWindows', () => {
  it('publishes nothing without a Shabbat config', async () => {
    const session = await createHousehold();
    await push(session, [{ table: 'householdSettings', record: settings() }]);

    expect(await publishWindows(env.DB, session.householdId, NOW_MS)).toBe(0);
    expect(await countWindows(session.householdId)).toBe(0);
  });

  it('publishes nothing without household settings — a window needs the household timezone', async () => {
    const session = await createHousehold();
    // The config alone is not enough: every published time is read, displayed and reasoned about
    // in the household's own zone, and guessing one is how times end up plausibly wrong.
    await push(session, [{ table: 'shabbatConfig', record: shabbatConfig() }]);

    await env.DB.prepare('DELETE FROM household_settings WHERE household_id = ?')
      .bind(session.householdId)
      .run();

    expect(await publishWindows(env.DB, session.householdId, NOW_MS)).toBe(0);
  });

  it('publishes a horizon of windows a device can pull', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'shabbatConfig', record: shabbatConfig() },
    ]);

    // The config write alone triggers publication through the Durable Object — no separate call.
    const published = await countWindows(session.householdId);
    expect(published).toBeGreaterThan(10);

    // Bounded against the real clock, not `NOW_MS`: this publication came from the Durable Object
    // on the config write, which uses the real clock. Measuring it from the fixture date instead
    // spent its 5-day slack on however far today had drifted from that date — a deadline, not a
    // test.
    const publishedFromMs = Date.now();
    const furthest = await furthestPublishedMs(env.DB, session.householdId);
    expect(furthest).toBeGreaterThan(publishedFromMs);
    expect(furthest).toBeLessThanOrEqual(publishedFromMs + PUBLISH_HORIZON_MS + 5 * 86_400_000);

    // And they arrive over the ordinary sync surface, not a new channel.
    const response = await SELF.fetch(`${BASE}/sync/bootstrap`, authed(session));
    const body = (await response.json()) as { records: { table: string; payload: unknown }[] };
    const windows = body.records.filter((record) => record.table === 'shabbatWindows');
    expect(windows.length).toBe(published);

    const first = windows[0]!.payload as { startsAt: string; endsAt: string; kind: string };
    expect(fromIso(first.endsAt)).toBeGreaterThan(fromIso(first.startsAt));
    expect(['shabbat', 'yom_tov', 'combined']).toContain(first.kind);
  });

  it('is idempotent — republishing the same calendar adds nothing', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'shabbatConfig', record: shabbatConfig() },
    ]);

    // Baseline from a publish at `NOW_MS`, not from the push. The push publishes through
    // `publishWindowsIfStale`, which reads the *real* clock, so its 90-day horizon starts wherever
    // today happens to be while `NOW_MS` is pinned to a fixture date. Every Shabbat that falls
    // into the widening gap between the two is a genuinely new window, so counting the push's
    // output as the baseline made this fail on a date rather than on a defect — which it duly did
    // once the real date drifted a Shabbat past the fixture.
    await publishWindows(env.DB, session.householdId, NOW_MS);
    const before = await countWindows(session.householdId);

    await publishWindows(env.DB, session.householdId, NOW_MS);
    await publishWindows(env.DB, session.householdId, NOW_MS);

    expect(await countWindows(session.householdId)).toBe(before);
  });

  it('moves the times when the configuration changes', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'shabbatConfig', record: shabbatConfig() },
    ]);

    const startsAtWith18 = await env.DB.prepare(
      'SELECT starts_at FROM shabbat_windows WHERE household_id = ? ORDER BY starts_at LIMIT 1',
    )
      .bind(session.householdId)
      .first<{ starts_at: string }>();

    await push(session, [
      {
        table: 'shabbatConfig',
        record: shabbatConfig({
          candleLightingOffsetMins: 40,
          updatedAt: toIso(NOW_MS + 60_000),
        }),
      },
    ]);

    const startsAtWith40 = await env.DB.prepare(
      'SELECT starts_at FROM shabbat_windows WHERE household_id = ? ORDER BY starts_at LIMIT 1',
    )
      .bind(session.householdId)
      .first<{ starts_at: string }>();

    // A caregiver who corrects the offset expects the screen to change; the old window must not
    // linger beside the new one.
    expect(fromIso(startsAtWith40!.starts_at)).toBeLessThan(fromIso(startsAtWith18!.starts_at));
  });

  it('prunes windows long past but keeps recent ones for reconciliation', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'shabbatConfig', record: shabbatConfig() },
    ]);

    const laterMs = NOW_MS + 200 * 86_400_000;
    await publishWindows(env.DB, session.householdId, laterMs);

    const oldest = await env.DB.prepare(
      'SELECT MIN(ends_at) AS ends_at FROM shabbat_windows WHERE household_id = ?',
    )
      .bind(session.householdId)
      .first<{ ends_at: string }>();

    expect(fromIso(oldest!.ends_at)).toBeGreaterThan(laterMs - 31 * 86_400_000);
  });
});

describe('publishWindowsIfStale', () => {
  it('does nothing while the horizon is still long', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'shabbatConfig', record: shabbatConfig() },
    ]);

    expect(await publishWindowsIfStale(env.DB, session.householdId, NOW_MS)).toBe(0);
  });

  it('tops the horizon up as it runs short, with no config change to prompt it', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'shabbatConfig', record: shabbatConfig() },
    ]);

    // Two months later: the household has not touched its settings, and nobody has opened the
    // app. Windows must still be there, or Shabbat silently stops being detected.
    const laterMs = NOW_MS + 70 * 86_400_000;
    expect(await publishWindowsIfStale(env.DB, session.householdId, laterMs)).toBeGreaterThan(0);

    const furthest = await furthestPublishedMs(env.DB, session.householdId);
    expect(furthest).toBeGreaterThan(laterMs + 60 * 86_400_000);
  });
});

describe('the sync surface', () => {
  it('refuses a client-written window', async () => {
    const session = await createHousehold();
    const body = await push(session, [
      {
        table: 'shabbatWindows',
        record: {
          id: 'shabbat:2026-08-14T16:03:00.000Z',
          patientId: SINGLE_PATIENT_ID,
          kind: 'shabbat',
          label: 'Shabbat',
          startsAt: '2026-08-14T16:03:00.000Z',
          endsAt: '2026-08-15T17:01:00.000Z',
          generatedAt: toIso(NOW_MS),
          updatedAt: toIso(NOW_MS),
          updatedByDeviceId: 'device',
          syncStatus: 'synced',
        },
      },
    ]);

    // A device that could publish its own windows could move every other device in the household
    // into or out of Shabbat mode.
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.table).toBe('shabbatWindows');
    expect(await countWindows(session.householdId)).toBe(0);
  });
});
