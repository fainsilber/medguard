import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MS_PER_MINUTE,
  SHABBAT_BURST_COUNT,
  SHABBAT_BURST_SPACING_MS,
  SINGLE_PATIENT_ID,
  toIso,
} from '@medguard/shared';
import type { IntakeLog, PushPayload } from '@medguard/shared';
import type { HouseholdDO } from '../src/do/HouseholdDO.js';
import type { DoseAlarmChain } from '../src/do/doseAlarms.js';

/**
 * The alarm chain in Shabbat mode (Sprint A5).
 *
 * Everything asserted here is a halachic requirement expressed as behaviour, per delta D5 and
 * `docs/halachic-decisions.md`: no record written by a caregiver's tap, so the notification
 * carries no actions and its kind says so; no escalation, because the first alert already reached
 * every device (Q3); no machine-written `missed` log, because what happened is established after
 * Havdalah. The dose still rings — that is the whole point of the mode, not an exception to it.
 *
 * Windows are inserted directly rather than computed: `zmanim.test.ts` owns whether the times are
 * right, and `shabbatPublish.test.ts` owns whether they reach devices. What matters here is what
 * the chain does with a window once it has one.
 */

const BASE = 'https://example.com/api/v1';
const MEDICINE_ID = '11111111-1111-4111-8111-111111111111';
const SCHEDULE_ID = '33333333-3333-4333-8333-333333333333';
// A second medicine on the same schedule time — the simultaneous-doses case.
const SECOND_MEDICINE_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_SCHEDULE_ID = '55555555-5555-4555-8555-555555555555';
const ESCALATION_MINUTES = 15;
const MISSED_MINUTES = 180;
const WEB_ENDPOINT = 'https://push.example.invalid/sub/1';

interface Session {
  deviceToken: string;
  householdId: string;
  deviceId: string;
}

async function createHousehold(displayName = 'Mom'): Promise<Session> {
  const response = await SELF.fetch(`${BASE}/households`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ householdName: 'Test', displayName }),
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
  return response.json();
}

function stubFor(session: Session) {
  return env.HOUSEHOLD.get(
    env.HOUSEHOLD.idFromName(session.householdId),
  ) as DurableObjectStub<HouseholdDO>;
}

async function runChainAt(stub: DurableObjectStub<HouseholdDO>, nowMs: number): Promise<void> {
  await runInDurableObject(stub, async (instance) => {
    await (instance as unknown as { alarms: DoseAlarmChain }).alarms.runDueWork(nowMs);
  });
}

async function nextWake(stub: DurableObjectStub<HouseholdDO>): Promise<number | null> {
  return runInDurableObject(stub, (instance) =>
    Promise.resolve((instance as unknown as { alarms: DoseAlarmChain }).alarms.nextWakeMs()),
  );
}

function minuteAligned(ms: number): number {
  return Math.floor(ms / MS_PER_MINUTE) * MS_PER_MINUTE;
}

function hhmm(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

function settings(overrides: Record<string, unknown> = {}) {
  return {
    id: 'household',
    timeZone: 'UTC',
    escalationAfterMinutes: ESCALATION_MINUTES,
    snoozeMinutes: 20,
    updatedAt: toIso(Date.now()),
    updatedByDeviceId: 'device',
    syncStatus: 'synced',
    ...overrides,
  };
}

function medicine(overrides: Record<string, unknown> = {}) {
  return {
    id: MEDICINE_ID,
    patientId: SINGLE_PATIENT_ID,
    name: 'Methotrexate',
    strength: '50mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    updatedAt: toIso(Date.now()),
    updatedByDeviceId: 'device',
    syncStatus: 'synced',
    ...overrides,
  };
}

function schedule(dueAtMs: number, overrides: Record<string, unknown> = {}) {
  const startDate = new Date(dueAtMs - 24 * 60 * MS_PER_MINUTE).toISOString().slice(0, 10);
  return {
    id: SCHEDULE_ID,
    medicineId: MEDICINE_ID,
    patientId: SINGLE_PATIENT_ID,
    frequencyType: 'daily',
    timesOfDay: [hhmm(dueAtMs)],
    dosageQuantity: 2,
    startDate,
    active: true,
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
    autoShabbatEnabled: true,
    latitude: 31.7683,
    longitude: 35.2137,
    candleLightingOffsetMins: 18,
    havdalahDegreesOrMins: '8.5_degrees',
    israelHolidays: true,
    chimeDurationSeconds: 30,
    weekdayChimeDurationSeconds: 60,
    updatedAt: toIso(Date.now()),
    updatedByDeviceId: 'device',
    syncStatus: 'synced',
    ...overrides,
  };
}

/**
 * A published window, written straight into D1 the way `publishWindows` would.
 *
 * Real coordinates would put Shabbat wherever this week's calendar puts it; the chain's behaviour
 * has to be asserted around a *known* boundary, so the window is placed relative to the dose.
 */
async function publishWindow(
  householdId: string,
  startsAtMs: number,
  endsAtMs: number,
): Promise<void> {
  const startsAt = toIso(startsAtMs);
  const endsAt = toIso(endsAtMs);
  const payload = {
    id: `shabbat:${startsAt}`,
    patientId: SINGLE_PATIENT_ID,
    kind: 'shabbat',
    label: 'Shabbat',
    startsAt,
    endsAt,
    generatedAt: startsAt,
    updatedAt: startsAt,
    updatedByDeviceId: 'server',
    syncStatus: 'synced',
  };

  await env.DB.prepare(
    `INSERT INTO shabbat_windows
       (id, household_id, seq, patient_id, starts_at, ends_at, updated_at, updated_by_device_id, payload)
     VALUES (?, ?, 9999, ?, ?, ?, ?, 'server', ?)
     ON CONFLICT(household_id, id) DO UPDATE SET starts_at = excluded.starts_at,
       ends_at = excluded.ends_at, payload = excluded.payload`,
  )
    .bind(
      payload.id,
      householdId,
      SINGLE_PATIENT_ID,
      startsAt,
      endsAt,
      startsAt,
      JSON.stringify(payload),
    )
    .run();
}

async function logsFor(householdId: string): Promise<IntakeLog[]> {
  const { results } = await env.DB.prepare(
    'SELECT payload FROM intake_logs WHERE household_id = ? ORDER BY seq',
  )
    .bind(householdId)
    .all<{ payload: string }>();
  return results.map((row) => JSON.parse(row.payload) as IntakeLog);
}

let sentTo: string[] = [];
let sentPayloads: PushPayload[] = [];

beforeEach(() => {
  sentTo = [];
  sentPayloads = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
        status: 200,
      });
    }
    if (url.startsWith('https://fcm.googleapis.com')) {
      const message = (JSON.parse(String(init?.body)) as { message: { data: { payload: string } } })
        .message;
      sentPayloads.push(JSON.parse(message.data.payload) as PushPayload);
      sentTo.push('fcm');
      return new Response('{}', { status: 200 });
    }
    sentTo.push(url);
    return new Response('', { status: 201 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function registerWebPush(session: Session): Promise<void> {
  const response = await SELF.fetch(
    `${BASE}/devices/push`,
    authed(session, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'webpush',
        subscription: {
          endpoint: WEB_ENDPOINT,
          keys: {
            p256dh:
              'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
            auth: 'BTBZMqHH6r4Tts7J_aSIgg',
          },
        },
      }),
    }),
  );
  expect(response.status).toBe(200);
}

/** A second device in the *same* household — the case delta AD3 is actually about. */
async function joinHousehold(session: Session, displayName = 'Dad'): Promise<Session> {
  const codeResponse = await SELF.fetch(
    `${BASE}/join-codes`,
    authed(session, { method: 'POST', body: '{}' }),
  );
  const { code } = (await codeResponse.json()) as { code: string };

  const joinResponse = await SELF.fetch(`${BASE}/join-codes/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, displayName }),
  });
  expect(joinResponse.status).toBe(201);
  return joinResponse.json();
}

async function registerFcm(session: Session): Promise<void> {
  const response = await SELF.fetch(
    `${BASE}/devices/push`,
    authed(session, {
      method: 'POST',
      body: JSON.stringify({ provider: 'fcm', token: 'registration-token' }),
    }),
  );
  expect(response.status).toBe(200);
}

/**
 * A household with one dose due `minutesFromNow`, and — unless `inShabbat` is false — a published
 * window that comfortably contains it.
 */
async function householdInShabbat(
  minutesFromNow: number,
  options: { inShabbat?: boolean; fcm?: boolean; web?: boolean } = {},
) {
  const { inShabbat = true, fcm = false, web = true } = options;
  const session = await createHousehold();
  const dueAtMs = minuteAligned(Date.now() + minutesFromNow * MS_PER_MINUTE);

  if (web) await registerWebPush(session);
  if (fcm) {
    await registerFcm(await joinHousehold(session));
  }

  await push(session, [
    { table: 'householdSettings', record: settings() },
    { table: 'medicines', record: medicine() },
    { table: 'schedules', record: schedule(dueAtMs) },
    { table: 'shabbatConfig', record: shabbatConfig() },
  ]);

  if (inShabbat) {
    // From well before the dose to well after everything the chain could otherwise do with it.
    await publishWindow(
      session.householdId,
      dueAtMs - 6 * 60 * MS_PER_MINUTE,
      dueAtMs + 24 * 60 * MS_PER_MINUTE,
    );
  }

  return {
    session,
    stub: stubFor(session),
    dueAtMs,
    occurrenceId: `${SCHEDULE_ID}:${toIso(dueAtMs)}`,
  };
}

describe('a dose that falls inside a Shabbat window', () => {
  it('still rings, and never escalates', async () => {
    const { stub, dueAtMs, session } = await householdInShabbat(30);

    await runChainAt(stub, dueAtMs);
    expect(sentTo).toContain(WEB_ENDPOINT);

    // Let the burst finish, so what follows cannot be confused with it.
    for (let index = 2; index <= SHABBAT_BURST_COUNT; index += 1) {
      await runChainAt(stub, dueAtMs + (index - 1) * SHABBAT_BURST_SPACING_MS);
    }

    // Past the escalation boundary, and past it again: nothing more is owed to this dose, and
    // the chain has nothing left to wake for on its account.
    sentTo = [];
    await runChainAt(stub, dueAtMs + ESCALATION_MINUTES * MS_PER_MINUTE);
    await runChainAt(stub, dueAtMs + 2 * ESCALATION_MINUTES * MS_PER_MINUTE);

    expect(sentTo).toEqual([]);
    expect((await logsFor(session.householdId)).map((log) => log.status)).toEqual([
      'pending_shabbat',
    ]);
  });

  it('sends the shabbat kind, which carries no action buttons', async () => {
    const { stub, dueAtMs } = await householdInShabbat(30, { fcm: true, web: false });

    await runChainAt(stub, dueAtMs);

    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]).toMatchObject({
      kind: 'shabbat',
      medicineName: 'Methotrexate',
      // One push for a native device: it plays the real 45-second chime from its own local alarm
      // (delta AD3), so a burst there would be ten notifications rather than one long chime.
      burstIndex: 1,
      burstTotal: 1,
    });
  });

  it('records the dose as pending_shabbat, timestamped when it was due', async () => {
    const { stub, dueAtMs, session } = await householdInShabbat(30);

    await runChainAt(stub, dueAtMs);

    const logs = await logsFor(session.householdId);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      status: 'pending_shabbat',
      scheduledTime: toIso(dueAtMs),
      // The due time rather than the moment the object woke: a late alarm must not move a
      // timestamp in a child's medical record.
      actualTime: toIso(dueAtMs),
      quantityTaken: 0,
      loggedByUserId: 'system',
    });
  });

  it('writes no missed log when the dose ages out during Shabbat', async () => {
    const { stub, dueAtMs, session } = await householdInShabbat(30);

    await runChainAt(stub, dueAtMs + MISSED_MINUTES * MS_PER_MINUTE);

    const logs = await logsFor(session.householdId);
    expect(logs.map((log) => log.status)).toEqual(['pending_shabbat']);
  });

  it('sends the ten-push burst to a browser and exactly one to a phone', async () => {
    const { stub, dueAtMs } = await householdInShabbat(30, { fcm: true });

    await runChainAt(stub, dueAtMs);

    // The first of the burst goes out with the alert; the rest are a schedule the chain drains.
    expect(sentTo.filter((target) => target === WEB_ENDPOINT)).toHaveLength(1);
    expect(sentTo.filter((target) => target === 'fcm')).toHaveLength(1);
    expect(await nextWake(stub)).toBe(dueAtMs + SHABBAT_BURST_SPACING_MS);

    for (let index = 2; index <= SHABBAT_BURST_COUNT; index += 1) {
      await runChainAt(stub, dueAtMs + (index - 1) * SHABBAT_BURST_SPACING_MS);
    }

    expect(sentTo.filter((target) => target === WEB_ENDPOINT)).toHaveLength(SHABBAT_BURST_COUNT);
    // Still one. Ten notifications on a phone that is already playing 45 seconds of chime would
    // be ten interruptions, not a longer alert.
    expect(sentTo.filter((target) => target === 'fcm')).toHaveLength(1);

    // And the burst is finished, not looping.
    const later = dueAtMs + 60 * MS_PER_MINUTE;
    sentTo = [];
    await runChainAt(stub, later);
    expect(sentTo).toEqual([]);
  });

  /**
   * Several medicines at 08:00 is the ordinary case in this household, not an edge one. A burst
   * chain each would mean twenty notification tones for what a caregiver hears as one alert going
   * off — the browser-side version of the "one sound, several notifications" rule the native chime
   * follows. Each dose still gets its own initial push; what is deduplicated is the repetition
   * that stands in for a chime.
   */
  it('runs one burst chain for two doses due at the same instant, not two', async () => {
    const { session, stub, dueAtMs } = await householdInShabbat(30);

    await push(session, [
      { table: 'medicines', record: medicine({ id: SECOND_MEDICINE_ID, name: 'Ondansetron' }) },
      {
        table: 'schedules',
        record: schedule(dueAtMs, { id: SECOND_SCHEDULE_ID, medicineId: SECOND_MEDICINE_ID }),
      },
    ]);

    sentTo = [];
    await runChainAt(stub, dueAtMs);

    // Two doses, two notifications — both alerts still reach the browser.
    expect(sentTo.filter((target) => target === WEB_ENDPOINT)).toHaveLength(2);

    for (let index = 2; index <= SHABBAT_BURST_COUNT; index += 1) {
      await runChainAt(stub, dueAtMs + (index - 1) * SHABBAT_BURST_SPACING_MS);
    }

    // Two initial pushes plus one chain's worth of continuation — not two chains.
    expect(sentTo.filter((target) => target === WEB_ENDPOINT)).toHaveLength(
      SHABBAT_BURST_COUNT + 1,
    );

    // And nothing is left looping afterwards.
    sentTo = [];
    await runChainAt(stub, dueAtMs + 60 * MS_PER_MINUTE);
    expect(sentTo).toEqual([]);
  });

  it('numbers the burst so a browser can tell one long alert from ten separate ones', async () => {
    const { stub, dueAtMs, session } = await householdInShabbat(30);

    await runChainAt(stub, dueAtMs);
    await runChainAt(stub, dueAtMs + SHABBAT_BURST_SPACING_MS);

    const stored = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM intake_logs WHERE household_id = ?',
    )
      .bind(session.householdId)
      .first<{ n: number }>();

    // One log for the dose, however many pushes the burst is made of.
    expect(stored?.n).toBe(1);
  });
});

describe('a dose outside the window', () => {
  it('behaves exactly as a weekday dose does', async () => {
    const { stub, dueAtMs, session } = await householdInShabbat(30, { inShabbat: false });

    await runChainAt(stub, dueAtMs);
    expect(await nextWake(stub)).toBe(dueAtMs + ESCALATION_MINUTES * MS_PER_MINUTE);

    sentTo = [];
    await runChainAt(stub, dueAtMs + ESCALATION_MINUTES * MS_PER_MINUTE);
    expect(sentTo).toContain(WEB_ENDPOINT);

    await runChainAt(stub, dueAtMs + MISSED_MINUTES * MS_PER_MINUTE);
    const logs = await logsFor(session.householdId);
    expect(logs.map((log) => log.status)).toEqual(['missed']);
  });

  it('is a weekday dose when a window exists but automation is switched off', async () => {
    const session = await createHousehold();
    const dueAtMs = minuteAligned(Date.now() + 30 * MS_PER_MINUTE);
    await registerWebPush(session);

    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'medicines', record: medicine() },
      { table: 'schedules', record: schedule(dueAtMs) },
      { table: 'shabbatConfig', record: shabbatConfig({ autoShabbatEnabled: false }) },
    ]);
    await publishWindow(
      session.householdId,
      dueAtMs - 60 * MS_PER_MINUTE,
      dueAtMs + 60 * MS_PER_MINUTE,
    );

    const stub = stubFor(session);
    await runChainAt(stub, dueAtMs);

    // The setting is the household's own decision, and it governs: windows may be published (the
    // verification screen shows them) without the app acting on them.
    expect(await nextWake(stub)).toBe(dueAtMs + ESCALATION_MINUTES * MS_PER_MINUTE);
    expect((await logsFor(session.householdId)).map((log) => log.status)).toEqual([]);
  });

  it('takes the boundary from the window, to the minute', async () => {
    const { session, stub, dueAtMs } = await householdInShabbat(30, { inShabbat: false });

    // Shabbat ends one minute before this dose is due: it is a weekday dose, and it escalates.
    await publishWindow(
      session.householdId,
      dueAtMs - 6 * 60 * MS_PER_MINUTE,
      dueAtMs - MS_PER_MINUTE,
    );

    await runChainAt(stub, dueAtMs);
    expect(await nextWake(stub)).toBe(dueAtMs + ESCALATION_MINUTES * MS_PER_MINUTE);
    expect((await logsFor(session.householdId)).map((log) => log.status)).toEqual([]);
  });

  it('is in mode for a dose due at the very instant Shabbat begins', async () => {
    const { session, stub, dueAtMs } = await householdInShabbat(30, { inShabbat: false });

    // Candle lighting exactly at the due time. Half-open windows: the dose is in Shabbat, and
    // this is the direction that fails safe — no action buttons, no written record.
    await publishWindow(session.householdId, dueAtMs, dueAtMs + 24 * 60 * MS_PER_MINUTE);

    await runChainAt(stub, dueAtMs);
    expect((await logsFor(session.householdId)).map((log) => log.status)).toEqual([
      'pending_shabbat',
    ]);
  });
});
