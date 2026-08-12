import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MS_PER_DAY, MS_PER_MINUTE, SINGLE_PATIENT_ID, computeShabbatWindows, fromIso, toIso } from '@medguard/shared';
import type { PushPayload } from '@medguard/shared';
import type { HouseholdDO } from '../src/do/HouseholdDO.js';
import type { DoseAlarmChain } from '../src/do/doseAlarms.js';

/**
 * The Sprint A4 dose chain: dose alert, escalation, snooze deferral, missed sweep, low stock.
 *
 * The exit gate for this sprint is "escalation fires at exactly the configured boundary", so the
 * assertions here are about exact instants rather than about eventually-something-happens. Two
 * mechanisms make that possible without waiting three hours for a real dose to go missed:
 *
 *   - `nextWakeMs()` is asserted directly, which is the precise question — *when* has the chain
 *     decided the next thing is owed.
 *   - `runDueWork(nowMs)` takes the current instant as an argument (the same discipline as `Clock`
 *     everywhere else in this repo), so a test can stand at any moment on either side of a
 *     boundary. `runDurableObjectAlarm` covers the wiring from the platform's alarm into it.
 */

const BASE = 'https://example.com/api/v1';
const MEDICINE_ID = '11111111-1111-4111-8111-111111111111';
const SCHEDULE_ID = '33333333-3333-4333-8333-333333333333';

const ESCALATION_MINUTES = 15;
const SNOOZE_MINUTES = 20;
const MISSED_MINUTES = 180;

interface Session {
  deviceToken: string;
  householdId: string;
  userId: string;
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

async function push(
  session: Session,
  changes: { table: string; record: unknown }[],
): Promise<{ blocked: { id: string; reason: string }[] }> {
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

/** The chain is a private field; a test reaching it is reaching the DO's own instance. */
function chainOf(stub: DurableObjectStub<HouseholdDO>): Promise<DoseAlarmChain> {
  return runInDurableObject(stub, (instance) =>
    Promise.resolve((instance as unknown as { alarms: DoseAlarmChain }).alarms),
  );
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

// ---------------------------------------------------------------------------
// Fixtures. Times are expressed relative to "now" so the schedule always has a live occurrence,
// and the household timezone is UTC so a wall-clock HH:MM maps straight onto an instant.
// ---------------------------------------------------------------------------

/** The exact instant of the occurrence a schedule at `hhmm` produces today. */
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
    snoozeMinutes: SNOOZE_MINUTES,
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

const SHABBAT_ZMANIM = {
  latitude: 31.7683,
  longitude: 35.2137,
  candleLightingOffsetMins: 18,
  havdalahDegreesOrMins: '8.5_degrees',
  israelHolidays: true,
};

function shabbatConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    patientId: SINGLE_PATIENT_ID,
    autoShabbatEnabled: true,
    chimeDurationSeconds: 45,
    ...SHABBAT_ZMANIM,
    updatedAt: toIso(Date.now()),
    updatedByDeviceId: 'device',
    syncStatus: 'synced',
    ...overrides,
  };
}

/**
 * Minutes from now for a dose whose would-be-missed instant (due + `MISSED_MINUTES`) lands in the
 * middle of the next real Shabbat/Yom Tov window from `SHABBAT_ZMANIM`, computed against whenever
 * the test actually runs rather than a fixed date.
 */
function minutesUntilDoseMissedDuringShabbat(nowMs: number): number {
  const [window] = computeShabbatWindows(SHABBAT_ZMANIM, 'UTC', {
    fromMs: nowMs,
    toMs: nowMs + 14 * MS_PER_DAY,
  });
  if (!window) {
    throw new Error('expected a Shabbat/Yom Tov window in the next 14 days');
  }
  const targetMs = (fromIso(window.startsAt) + fromIso(window.endsAt)) / 2;
  const dueAtMs = minuteAligned(targetMs - MISSED_MINUTES * MS_PER_MINUTE);
  return Math.round((dueAtMs - nowMs) / MS_PER_MINUTE);
}

/** Registers a web-push credential so the household actually has somewhere to send. */
async function registerPush(session: Session): Promise<void> {
  const response = await SELF.fetch(
    `${BASE}/devices/push`,
    authed(session, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'webpush',
        subscription: {
          endpoint: 'https://push.example.invalid/sub/1',
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

/**
 * Sent pushes, decrypted only as far as "which endpoint, and what kind".
 *
 * The body is aes128gcm-encrypted to the subscription, so the payload itself is asserted in
 * `dispatch.test.ts` where the sender is called directly. Here what matters is *whether* and
 * *when* something was sent, which the endpoint and the count answer.
 */
let sentTo: string[] = [];
/** Populated for FCM sends, where the data map is plaintext. */
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

/** A household with one daily schedule whose next dose is `minutesFromNow` away. */
async function householdWithDose(minutesFromNow: number): Promise<{
  session: Session;
  stub: DurableObjectStub<HouseholdDO>;
  dueAtMs: number;
  occurrenceId: string;
}> {
  const session = await createHousehold();
  const dueAtMs = minuteAligned(Date.now() + minutesFromNow * MS_PER_MINUTE);

  await registerPush(session);
  await push(session, [
    { table: 'householdSettings', record: settings() },
    { table: 'medicines', record: medicine() },
    { table: 'schedules', record: schedule(dueAtMs) },
  ]);

  return {
    session,
    stub: stubFor(session),
    dueAtMs,
    occurrenceId: `${SCHEDULE_ID}:${toIso(dueAtMs)}`,
  };
}

describe('the dose chain', () => {
  it('arms for the dose the moment a schedule syncs', async () => {
    const { stub, dueAtMs } = await householdWithDose(30);

    expect(await nextWake(stub)).toBe(dueAtMs);
  });

  it('arms nothing until a household has synced its timezone — a guessed zone is the wrong hour', async () => {
    const session = await createHousehold();
    const dueAtMs = minuteAligned(Date.now() + 30 * MS_PER_MINUTE);

    await push(session, [
      { table: 'medicines', record: medicine() },
      { table: 'schedules', record: schedule(dueAtMs) },
    ]);

    expect(await nextWake(stubFor(session))).toBeNull();
  });

  it('sends the dose alert at the due time, then arms escalation for exactly the configured boundary', async () => {
    const { stub, dueAtMs } = await householdWithDose(30);

    await runChainAt(stub, dueAtMs);

    expect(sentTo).toContain('https://push.example.invalid/sub/1');
    expect(await nextWake(stub)).toBe(dueAtMs + ESCALATION_MINUTES * MS_PER_MINUTE);
  });

  it('does not escalate one millisecond before the boundary, and does at it', async () => {
    const { stub, dueAtMs } = await householdWithDose(30);
    const boundary = dueAtMs + ESCALATION_MINUTES * MS_PER_MINUTE;

    await runChainAt(stub, dueAtMs);
    sentTo = [];

    await runChainAt(stub, boundary - 1);
    expect(sentTo).toEqual([]);

    await runChainAt(stub, boundary);
    expect(sentTo).toContain('https://push.example.invalid/sub/1');
  });

  it('skips a stale "due now" alert when the escalation deadline has also passed', async () => {
    const { stub, dueAtMs } = await householdWithDose(30);

    // One wake, arriving an hour late — the DO was evicted, or the household was idle. Telling a
    // caregiver an hour-old dose is "due now" invites a second dose; escalation is the honest
    // message, and exactly one notification goes out rather than two.
    await runChainAt(stub, dueAtMs + 60 * MS_PER_MINUTE);

    expect(sentTo).toHaveLength(1);
    expect(await nextWake(stub)).toBe(dueAtMs + MISSED_MINUTES * MS_PER_MINUTE);
  });

  it('arms the platform alarm, and re-arms itself when it fires with nothing yet owed', async () => {
    const { stub, dueAtMs } = await householdWithDose(30);

    // Proves the DO really did `setAlarm`, and that the handler runs clean when it fires early.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(sentTo).toEqual([]);
    expect(await nextWake(stub)).toBe(dueAtMs);
  });

  it('sends from the real alarm handler, not only from the chain called directly', async () => {
    const { stub } = await householdWithDose(-1);

    // `alarm()` reads the wall clock itself; the dose is already a minute overdue, so this is the
    // whole production path — platform handler, `systemClock`, dispatch — end to end.
    await runInDurableObject(stub, (instance) => instance.alarm());

    expect(sentTo).toContain('https://push.example.invalid/sub/1');
  });
});

describe('acknowledgement', () => {
  it('stops the escalation the moment any device logs the dose', async () => {
    const { session, stub, dueAtMs, occurrenceId } = await householdWithDose(30);
    await runChainAt(stub, dueAtMs);
    sentTo = [];

    await push(session, [
      {
        table: 'intakeLogs',
        record: {
          id: '44444444-4444-4444-8444-444444444444',
          patientId: SINGLE_PATIENT_ID,
          medicineId: MEDICINE_ID,
          scheduleId: SCHEDULE_ID,
          type: 'scheduled',
          status: 'taken',
          scheduledTime: toIso(dueAtMs),
          actualTime: toIso(dueAtMs + MS_PER_MINUTE),
          quantityTaken: 2,
          loggedByUserId: session.userId,
          loggedByDeviceId: session.deviceId,
          syncStatus: 'synced',
        },
      },
    ]);

    await runChainAt(stub, dueAtMs + ESCALATION_MINUTES * MS_PER_MINUTE);

    expect(sentTo).toEqual([]);
    expect(occurrenceId).toContain(SCHEDULE_ID);
  });

  it('counts a skipped dose as answered — the caregiver did respond', async () => {
    const { session, stub, dueAtMs } = await householdWithDose(30);
    await runChainAt(stub, dueAtMs);
    sentTo = [];

    await push(session, [
      {
        table: 'intakeLogs',
        record: {
          id: '55555555-5555-4555-8555-555555555555',
          patientId: SINGLE_PATIENT_ID,
          medicineId: MEDICINE_ID,
          scheduleId: SCHEDULE_ID,
          type: 'scheduled',
          status: 'skipped',
          scheduledTime: toIso(dueAtMs),
          actualTime: toIso(dueAtMs),
          quantityTaken: 0,
          loggedByUserId: session.userId,
          loggedByDeviceId: session.deviceId,
          syncStatus: 'synced',
        },
      },
    ]);

    await runChainAt(stub, dueAtMs + ESCALATION_MINUTES * MS_PER_MINUTE);
    expect(sentTo).toEqual([]);
  });
});

describe('snooze', () => {
  function snoozeRecord(occurrenceId: string, createdAtMs: number, count: number, id: string) {
    return {
      table: 'doseSnoozes',
      record: {
        id,
        occurrenceId,
        minutes: SNOOZE_MINUTES,
        count,
        createdAt: toIso(createdAtMs),
        createdByUserId: 'user',
        createdByDeviceId: 'device',
        syncStatus: 'synced',
      },
    };
  }

  it('defers the alert by exactly the household snooze window, measured from the tap', async () => {
    const { session, stub, dueAtMs, occurrenceId } = await householdWithDose(30);
    await runChainAt(stub, dueAtMs);

    const tappedAtMs = dueAtMs + 2 * MS_PER_MINUTE;
    await push(session, [
      snoozeRecord(occurrenceId, tappedAtMs, 1, '66666666-6666-4666-8666-666666666666'),
    ]);

    expect(await nextWake(stub)).toBe(tappedAtMs + SNOOZE_MINUTES * MS_PER_MINUTE);
  });

  it('re-arms escalation from the deferred time, not the original due time', async () => {
    const { session, stub, dueAtMs, occurrenceId } = await householdWithDose(30);
    await runChainAt(stub, dueAtMs);

    const tappedAtMs = dueAtMs + 2 * MS_PER_MINUTE;
    await push(session, [
      snoozeRecord(occurrenceId, tappedAtMs, 1, '66666666-6666-4666-8666-666666666666'),
    ]);
    const deferredTo = tappedAtMs + SNOOZE_MINUTES * MS_PER_MINUTE;

    sentTo = [];
    await runChainAt(stub, deferredTo);
    expect(sentTo).toHaveLength(1);
    expect(await nextWake(stub)).toBe(deferredTo + ESCALATION_MINUTES * MS_PER_MINUTE);
  });

  it('refuses the fourth snooze on the server, not only in the UI', async () => {
    const { session, dueAtMs, occurrenceId } = await householdWithDose(30);

    for (let i = 1; i <= 3; i += 1) {
      const { blocked } = await push(session, [
        snoozeRecord(occurrenceId, dueAtMs + i * MS_PER_MINUTE, i, `7777777${i}-7777-4777-8777-777777777777`),
      ]);
      expect(blocked).toEqual([]);
    }

    const { blocked } = await push(session, [
      snoozeRecord(occurrenceId, dueAtMs + 4 * MS_PER_MINUTE, 4, '88888888-8888-4888-8888-888888888888'),
    ]);

    expect(blocked).toEqual([
      { table: 'doseSnoozes', id: '88888888-8888-4888-8888-888888888888', reason: 'snooze_limit_reached' },
    ]);
  });

  it('still accepts a resent snooze — a retried batch is not a fourth deferral', async () => {
    const { session, dueAtMs, occurrenceId } = await householdWithDose(30);
    const record = snoozeRecord(
      occurrenceId,
      dueAtMs + MS_PER_MINUTE,
      1,
      '99999999-9999-4999-8999-999999999999',
    );

    await push(session, [record]);
    const { blocked } = await push(session, [record]);

    expect(blocked).toEqual([]);
  });

  it('cannot defer a dose past the point where it is marked missed', async () => {
    const { session, stub, dueAtMs, occurrenceId } = await householdWithDose(30);

    // Three snoozes, each taken at the moment the previous one expired: the most generous
    // sequence a caregiver could actually produce.
    let tappedAtMs = dueAtMs;
    for (let i = 1; i <= 3; i += 1) {
      await push(session, [
        snoozeRecord(occurrenceId, tappedAtMs, i, `aaaaaaa${i}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`),
      ]);
      tappedAtMs += SNOOZE_MINUTES * MS_PER_MINUTE;
    }

    expect(tappedAtMs).toBeLessThan(dueAtMs + MISSED_MINUTES * MS_PER_MINUTE);
    expect(await nextWake(stub)).toBe(tappedAtMs);
  });
});

describe('the missed sweep (delta AD6)', () => {
  it('writes a real, correctable intake log three hours after the dose was due', async () => {
    const { session, stub, dueAtMs } = await householdWithDose(30);

    await runChainAt(stub, dueAtMs + MISSED_MINUTES * MS_PER_MINUTE);

    const row = await env.DB.prepare(
      'SELECT payload FROM intake_logs WHERE household_id = ? AND status = ?',
    )
      .bind(session.householdId, 'missed')
      .first<{ payload: string }>();

    expect(row).not.toBeNull();
    const log = JSON.parse(row!.payload) as Record<string, unknown>;
    expect(log).toMatchObject({
      medicineId: MEDICINE_ID,
      scheduleId: SCHEDULE_ID,
      status: 'missed',
      type: 'scheduled',
      scheduledTime: toIso(dueAtMs),
      // The instant it became missed, not the instant the alarm happened to run.
      actualTime: toIso(dueAtMs + MISSED_MINUTES * MS_PER_MINUTE),
      loggedByUserId: 'system',
      quantityTaken: 0,
    });
  });

  it('writes nothing once a caregiver has logged the dose, however late', async () => {
    const { session, stub, dueAtMs } = await householdWithDose(30);

    await push(session, [
      {
        table: 'intakeLogs',
        record: {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          patientId: SINGLE_PATIENT_ID,
          medicineId: MEDICINE_ID,
          scheduleId: SCHEDULE_ID,
          type: 'scheduled',
          status: 'taken',
          scheduledTime: toIso(dueAtMs),
          actualTime: toIso(dueAtMs + 90 * MS_PER_MINUTE),
          quantityTaken: 2,
          loggedByUserId: session.userId,
          loggedByDeviceId: session.deviceId,
          syncStatus: 'synced',
        },
      },
    ]);

    await runChainAt(stub, dueAtMs + MISSED_MINUTES * MS_PER_MINUTE);

    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM intake_logs WHERE household_id = ? AND status = ?',
    )
      .bind(session.householdId, 'missed')
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('marks a dose missed only once, however many times the chain runs', async () => {
    const { session, stub, dueAtMs } = await householdWithDose(30);

    await runChainAt(stub, dueAtMs + MISSED_MINUTES * MS_PER_MINUTE);
    await runChainAt(stub, dueAtMs + (MISSED_MINUTES + 10) * MS_PER_MINUTE);

    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM intake_logs WHERE household_id = ? AND status = ?',
    )
      .bind(session.householdId, 'missed')
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  it('writes nothing while the household is in Shabbat/Yom Tov mode (Sprint 6)', async () => {
    const nowMs = Date.now();
    const minutesFromNow = minutesUntilDoseMissedDuringShabbat(nowMs);

    const { session, stub, dueAtMs } = await householdWithDose(minutesFromNow);
    await push(session, [{ table: 'shabbatConfig', record: shabbatConfig() }]);

    await runChainAt(stub, dueAtMs + MISSED_MINUTES * MS_PER_MINUTE);

    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM intake_logs WHERE household_id = ? AND status = ?',
    )
      .bind(session.householdId, 'missed')
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('writes a missed log normally once Shabbat mode is not enabled for the household', async () => {
    // Same construction as above, but without registering a shabbatConfig row — proves the
    // suppression is conditional on opt-in, not an accidental blanket suppression.
    const nowMs = Date.now();
    const minutesFromNow = minutesUntilDoseMissedDuringShabbat(nowMs);

    const { session, stub, dueAtMs } = await householdWithDose(minutesFromNow);

    await runChainAt(stub, dueAtMs + MISSED_MINUTES * MS_PER_MINUTE);

    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM intake_logs WHERE household_id = ? AND status = ?',
    )
      .bind(session.householdId, 'missed')
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

describe('low stock (PRD §2.4)', () => {
  const ITEM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  function inventoryItem(refillThreshold: number) {
    return {
      id: ITEM_ID,
      medicineId: MEDICINE_ID,
      refillThreshold,
      unitName: 'pills',
      updatedAt: toIso(Date.now()),
      updatedByDeviceId: 'device',
      syncStatus: 'synced',
    };
  }

  function adjustment(id: string, delta: number, reason: string) {
    return {
      id,
      medicineId: MEDICINE_ID,
      delta,
      reason,
      createdAt: toIso(Date.now()),
      createdByUserId: 'user',
      createdByDeviceId: 'device',
      syncStatus: 'synced',
    };
  }

  it('notifies once on the way down, and not again on the next dose', async () => {
    const { session } = await householdWithDose(30);

    await push(session, [
      { table: 'inventoryItems', record: inventoryItem(5) },
      { table: 'inventoryAdjustments', record: adjustment('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 20, 'initial') },
    ]);
    sentTo = [];

    // 20 → 5: at the threshold, which `deriveInventoryState` counts as low.
    await push(session, [
      { table: 'inventoryAdjustments', record: adjustment('dddddddd-dddd-4ddd-8ddd-ddddddddddd2', -15, 'correction') },
    ]);
    expect(sentTo).toHaveLength(1);

    sentTo = [];
    await push(session, [
      { table: 'inventoryAdjustments', record: adjustment('dddddddd-dddd-4ddd-8ddd-ddddddddddd3', -1, 'dose') },
    ]);
    expect(sentTo).toEqual([]);
  });

  it('re-arms after a refill, so the next time stock runs low it says so again', async () => {
    const { session } = await householdWithDose(30);

    await push(session, [
      { table: 'inventoryItems', record: inventoryItem(5) },
      { table: 'inventoryAdjustments', record: adjustment('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', 5, 'initial') },
    ]);
    sentTo = [];

    await push(session, [
      { table: 'inventoryAdjustments', record: adjustment('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2', 50, 'refill') },
    ]);
    expect(sentTo).toEqual([]);

    await push(session, [
      { table: 'inventoryAdjustments', record: adjustment('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3', -50, 'correction') },
    ]);
    expect(sentTo).toHaveLength(1);
  });

  it('says nothing about a medicine with no inventory tracked', async () => {
    const { session } = await householdWithDose(30);
    sentTo = [];

    await push(session, [
      { table: 'inventoryAdjustments', record: adjustment('ffffffff-ffff-4fff-8fff-fffffffffff1', -1, 'dose') },
    ]);

    expect(sentTo).toEqual([]);
  });
});

describe('an fcm household', () => {
  it('receives the same typed payload the web client parses', async () => {
    const session = await createHousehold();
    const dueAtMs = minuteAligned(Date.now() + 30 * MS_PER_MINUTE);

    await SELF.fetch(
      `${BASE}/devices/push`,
      authed(session, {
        method: 'POST',
        body: JSON.stringify({ provider: 'fcm', token: 'registration-token' }),
      }),
    );
    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'medicines', record: medicine() },
      { table: 'schedules', record: schedule(dueAtMs) },
    ]);

    await runChainAt(stubFor(session), dueAtMs);

    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]).toMatchObject({
      kind: 'dose',
      medicineName: 'Methotrexate',
      occurrenceId: `${SCHEDULE_ID}:${toIso(dueAtMs)}`,
      dosageQuantity: 2,
    });
  });
});

describe('the chain across schedule edits', () => {
  it('follows a schedule to its new time without leaving the old one armed', async () => {
    const { session, stub, dueAtMs } = await householdWithDose(30);
    expect(await nextWake(stub)).toBe(dueAtMs);

    const movedTo = minuteAligned(Date.now() + 90 * MS_PER_MINUTE);
    await push(session, [
      {
        table: 'schedules',
        record: schedule(movedTo, { updatedAt: toIso(Date.now() + 1000) }),
      },
    ]);

    expect(await nextWake(stub)).toBe(movedTo);
  });

  it('drops the alarm when the medicine is archived', async () => {
    const { session, stub } = await householdWithDose(30);

    await push(session, [
      { table: 'medicines', record: medicine({ archived: true, updatedAt: toIso(Date.now() + 1000) }) },
    ]);

    expect(await nextWake(stub)).toBeNull();
  });

  it('re-derives the horizon when the chain runs dry rather than going quiet', async () => {
    const { stub, dueAtMs } = await householdWithDose(30);

    // Everything today is dealt with; tomorrow's dose is what should be armed next.
    await runChainAt(stub, dueAtMs);
    await runChainAt(stub, dueAtMs + MISSED_MINUTES * MS_PER_MINUTE);

    const chain = await chainOf(stub);
    expect(chain).toBeDefined();
    expect(await nextWake(stub)).toBe(dueAtMs + 24 * 60 * MS_PER_MINUTE);
  });
});
