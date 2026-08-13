import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { MS_PER_HOUR, SINGLE_PATIENT_ID, fromIso, toIso } from '@medguard/shared';
import type { IntakeLog } from '@medguard/shared';

/**
 * The Motzei Shabbat reconciliation, server side (Sprint A5 phase 2).
 *
 * Two properties, both of which only a serialized writer can hold:
 *
 *   1. **Two caregivers cannot double-log one dose.** Both open the sheet after Havdalah, both
 *      answer the same dose, and the second is refused — otherwise the record carries two current
 *      truths for one dose and the ledger decrements stock twice for it.
 *   2. **A retroactively entered dose is judged as of when it was given**, not when it was typed.
 *      A PRN dose given during Shabbat and recorded afterwards must still face the cooldown that
 *      applied at the time, and must still be recordable with an explicit override — because it
 *      already happened, and a medical record that refuses to hold a fact is worse than one that
 *      records it with a reason attached.
 */

const BASE = 'https://example.com/api/v1';
const MEDICINE_ID = '11111111-1111-4111-8111-111111111111';
const SCHEDULE_ID = '33333333-3333-4333-8333-333333333333';
/** A Shabbat that has ended: candle lighting Friday 14 Aug 2026, Havdalah Saturday night. */
const DUE_AT = '2026-08-14T18:00:00.000Z';

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

interface PushResponse {
  results: { table: string; id: string; outcome: string }[];
  blocked: { table: string; id: string; reason: string }[];
  rejected: { table: string; id: string | null }[];
}

async function push(
  session: Session,
  changes: { table: string; record: unknown }[],
): Promise<PushResponse> {
  const response = await SELF.fetch(
    `${BASE}/sync/push`,
    authed(session, { method: 'POST', body: JSON.stringify({ changes }) }),
  );
  expect(response.status).toBe(200);
  return response.json();
}

function settings() {
  return {
    id: 'household',
    timeZone: 'Asia/Jerusalem',
    escalationAfterMinutes: 15,
    snoozeMinutes: 20,
    updatedAt: toIso(Date.now()),
    updatedByDeviceId: 'device',
    syncStatus: 'synced',
  };
}

function medicine(overrides: Record<string, unknown> = {}) {
  return {
    id: MEDICINE_ID,
    patientId: SINGLE_PATIENT_ID,
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    updatedAt: toIso(Date.now()),
    updatedByDeviceId: 'device',
    syncStatus: 'synced',
    ...overrides,
  };
}

/** The placeholder the alarm chain writes when a dose alert fires during Shabbat. */
function pendingShabbatLog(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    patientId: SINGLE_PATIENT_ID,
    medicineId: MEDICINE_ID,
    scheduleId: SCHEDULE_ID,
    type: 'scheduled',
    status: 'pending_shabbat',
    scheduledTime: DUE_AT,
    actualTime: DUE_AT,
    quantityTaken: 0,
    loggedByUserId: 'system',
    loggedByDeviceId: 'system',
    syncStatus: 'synced',
    ...overrides,
  };
}

function reconciliationLog(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    patientId: SINGLE_PATIENT_ID,
    medicineId: MEDICINE_ID,
    scheduleId: SCHEDULE_ID,
    type: 'scheduled',
    status: 'taken',
    scheduledTime: DUE_AT,
    actualTime: DUE_AT,
    quantityTaken: 1,
    loggedByUserId: 'mom',
    loggedByDeviceId: 'device-a',
    supersedesId: pendingShabbatLog().id,
    syncStatus: 'pending',
    ...overrides,
  };
}

function doseAdjustment(id: string, relatedLogId: string) {
  return {
    id,
    medicineId: MEDICINE_ID,
    delta: -1,
    reason: 'dose',
    relatedLogId,
    createdAt: toIso(Date.now()),
    createdByUserId: 'mom',
    createdByDeviceId: 'device-a',
    syncStatus: 'pending',
  };
}

async function storedLogs(householdId: string): Promise<IntakeLog[]> {
  const { results } = await env.DB.prepare(
    'SELECT payload FROM intake_logs WHERE household_id = ? ORDER BY seq',
  )
    .bind(householdId)
    .all<{ payload: string }>();
  return results.map((row) => JSON.parse(row.payload) as IntakeLog);
}

/** A household with the pending_shabbat placeholder already recorded, ready to reconcile. */
async function householdAwaitingReconciliation(): Promise<Session> {
  const session = await createHousehold();
  await push(session, [
    { table: 'householdSettings', record: settings() },
    { table: 'medicines', record: medicine() },
    { table: 'intakeLogs', record: pendingShabbatLog() },
  ]);
  return session;
}

describe('reconciling a Shabbat dose', () => {
  it('accepts the first answer and records it as superseding the placeholder', async () => {
    const session = await householdAwaitingReconciliation();

    const body = await push(session, [
      { table: 'intakeLogs', record: reconciliationLog('66666666-6666-4666-8666-666666666661') },
    ]);

    expect(body.blocked).toEqual([]);
    const logs = await storedLogs(session.householdId);
    expect(logs.map((log) => log.status)).toEqual(['pending_shabbat', 'taken']);
    expect(logs[1]!.supersedesId).toBe(pendingShabbatLog().id);
  });

  it('refuses a second answer from another caregiver, naming who got there first', async () => {
    const mom = await householdAwaitingReconciliation();
    const dad = await joinHousehold(mom);

    await push(mom, [
      { table: 'intakeLogs', record: reconciliationLog('66666666-6666-4666-8666-666666666661') },
    ]);

    const body = await push(dad, [
      {
        table: 'intakeLogs',
        record: reconciliationLog('66666666-6666-4666-8666-666666666662', {
          status: 'skipped',
          quantityTaken: 0,
          loggedByUserId: 'dad',
          loggedByDeviceId: 'device-b',
        }),
      },
    ]);

    expect(body.blocked).toHaveLength(1);
    expect(body.blocked[0]).toMatchObject({ table: 'intakeLogs', reason: 'already_superseded' });

    // One answer in the record, not two — and the one that arrived first.
    const logs = await storedLogs(mom.householdId);
    expect(logs.filter((log) => log.supersedesId === pendingShabbatLog().id)).toHaveLength(1);
    expect(logs.find((log) => log.supersedesId !== undefined)?.status).toBe('taken');
  });

  it('refuses the stock movement that came with the losing answer', async () => {
    const mom = await householdAwaitingReconciliation();
    const dad = await joinHousehold(mom);

    await push(mom, [
      { table: 'intakeLogs', record: reconciliationLog('66666666-6666-4666-8666-666666666661') },
      {
        table: 'inventoryAdjustments',
        record: doseAdjustment(
          '77777777-7777-4777-8777-777777777771',
          '66666666-6666-4666-8666-666666666661',
        ),
      },
    ]);

    const losingLogId = '66666666-6666-4666-8666-666666666662';
    const body = await push(dad, [
      { table: 'intakeLogs', record: reconciliationLog(losingLogId, { loggedByUserId: 'dad' }) },
      {
        table: 'inventoryAdjustments',
        record: doseAdjustment('77777777-7777-4777-8777-777777777772', losingLogId),
      },
    ]);

    // Stock decremented once for one dose. The adjustment is refused by the existing
    // "its log was never accepted" rule, so the ledger cannot drift even by accident.
    expect(body.blocked.map((item) => item.reason)).toEqual([
      'already_superseded',
      'related_log_not_accepted',
    ]);

    const { results } = await env.DB.prepare(
      'SELECT payload FROM inventory_adjustments WHERE household_id = ?',
    )
      .bind(mom.householdId)
      .all<{ payload: string }>();
    expect(results).toHaveLength(1);
  });

  it('accepts a resent batch as a duplicate rather than as a conflict with itself', async () => {
    const session = await householdAwaitingReconciliation();
    const record = reconciliationLog('66666666-6666-4666-8666-666666666661');

    await push(session, [{ table: 'intakeLogs', record }]);
    const retry = await push(session, [{ table: 'intakeLogs', record }]);

    // The retry path append-only dedup exists for: a resend is the same record, not a second one.
    expect(retry.blocked).toEqual([]);
    expect(retry.results[0]).toMatchObject({ outcome: 'duplicate' });
  });

  it('lets a correction of an answered dose through — a mistake is still correctable', async () => {
    const session = await householdAwaitingReconciliation();
    const firstId = '66666666-6666-4666-8666-666666666661';

    await push(session, [{ table: 'intakeLogs', record: reconciliationLog(firstId) }]);

    // Superseding the *answer*, not the placeholder: this is the ordinary correction path, and
    // refusing it would make a reconciliation the one thing in the app nobody can fix.
    const body = await push(session, [
      {
        table: 'intakeLogs',
        record: reconciliationLog('66666666-6666-4666-8666-666666666663', {
          status: 'skipped',
          quantityTaken: 0,
          supersedesId: firstId,
        }),
      },
    ]);

    expect(body.blocked).toEqual([]);
  });
});

describe('retroactive PRN entry', () => {
  const PRN_MEDICINE = medicine({
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Ondansetron PRN',
    asNeeded: true,
    minHoursBetweenDoses: 6,
  });

  function prnLog(id: string, actualTime: string, overrides: Record<string, unknown> = {}) {
    return {
      id,
      patientId: SINGLE_PATIENT_ID,
      medicineId: PRN_MEDICINE.id,
      type: 'prn',
      status: 'taken',
      actualTime,
      quantityTaken: 1,
      loggedByUserId: 'mom',
      loggedByDeviceId: 'device-a',
      syncStatus: 'pending',
      ...overrides,
    };
  }

  it('judges a dose entered after Havdalah as of when it was actually given', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'medicines', record: PRN_MEDICINE },
    ]);

    const firstMs = fromIso(DUE_AT);
    const first = await push(session, [
      { table: 'intakeLogs', record: prnLog('88888888-8888-4888-8888-888888888881', DUE_AT) },
    ]);
    expect(first.blocked).toEqual([]);

    // Eight hours later, inside the same Shabbat but outside the six-hour cooldown. Entered now,
    // long after both — and accepted, because the guard is judged at the dose's own instant.
    const second = await push(session, [
      {
        table: 'intakeLogs',
        record: prnLog('88888888-8888-4888-8888-888888888882', toIso(firstMs + 8 * MS_PER_HOUR)),
      },
    ]);
    expect(second.blocked).toEqual([]);
  });

  it('blocks a retroactive dose that really did break the cooldown', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'medicines', record: PRN_MEDICINE },
    ]);

    const firstMs = fromIso(DUE_AT);
    await push(session, [
      { table: 'intakeLogs', record: prnLog('88888888-8888-4888-8888-888888888881', DUE_AT) },
    ]);

    const body = await push(session, [
      {
        table: 'intakeLogs',
        record: prnLog('88888888-8888-4888-8888-888888888883', toIso(firstMs + 2 * MS_PER_HOUR)),
      },
    ]);

    expect(body.blocked[0]).toMatchObject({ reason: 'cooldown' });
  });

  it('records it anyway when the caregiver says what happened and why', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'householdSettings', record: settings() },
      { table: 'medicines', record: PRN_MEDICINE },
    ]);

    const firstMs = fromIso(DUE_AT);
    await push(session, [
      { table: 'intakeLogs', record: prnLog('88888888-8888-4888-8888-888888888881', DUE_AT) },
    ]);

    const body = await push(session, [
      {
        table: 'intakeLogs',
        record: prnLog('88888888-8888-4888-8888-888888888884', toIso(firstMs + 2 * MS_PER_HOUR), {
          override: {
            confirmedByUserId: 'mom',
            reason: 'Vomited the first dose; gave a second on the oncologist’s instruction.',
            blockedBy: 'cooldown',
          },
        }),
      },
    ]);

    // The dose happened. A record that refuses to hold a fact is worse than one that holds it
    // with a reason attached (safety invariant 5).
    expect(body.blocked).toEqual([]);
    const logs = await storedLogs(session.householdId);
    expect(logs).toHaveLength(2);
    expect(logs[1]!.override?.blockedBy).toBe('cooldown');
  });
});
