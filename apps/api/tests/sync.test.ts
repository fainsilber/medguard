import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { SINGLE_PATIENT_ID } from '@medguard/shared';

/**
 * The sync surface, against real routes and real D1.
 *
 * Two properties here are load-bearing for patient safety, and each has its own test below:
 * replaying a batch must never apply a dose twice, and no request may ever reach another
 * household's data.
 */

const BASE = 'https://example.com/api/v1';
const MEDICINE_ID = '11111111-1111-4111-8111-111111111111';
const LOG_ID = '22222222-2222-4222-8222-222222222222';

interface Session {
  deviceToken: string;
  householdId: string;
  userId: string;
  deviceId: string;
}

interface SyncRecord {
  table: string;
  id: string;
  seq: number;
  payload: Record<string, unknown>;
}

interface SyncResponse {
  cursor: number;
  records: SyncRecord[];
  hasMore: boolean;
  results: { table: string; id: string; outcome: string }[];
  rejected: { table: string; id: string | null }[];
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
  return { status: response.status, body: (await response.json()) as SyncResponse };
}

async function pull(session: Session, cursor = 0) {
  const response = await SELF.fetch(`${BASE}/sync/pull?cursor=${cursor}`, authed(session));
  return { status: response.status, body: (await response.json()) as SyncResponse };
}

function medicine(overrides: Record<string, unknown> = {}) {
  return {
    id: MEDICINE_ID,
    patientId: SINGLE_PATIENT_ID,
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: true,
    minHoursBetweenDoses: 4,
    archived: false,
    updatedAt: '2026-08-03T10:00:00.000Z',
    updatedByDeviceId: 'device-a',
    syncStatus: 'synced',
    ...overrides,
  };
}

const SNOOZE_ID = '44444444-4444-4444-8444-444444444444';
const OCCURRENCE_ID = `${MEDICINE_ID}:2026-08-03T10:00:00.000Z`;

function doseSnooze(overrides: Record<string, unknown> = {}) {
  return {
    id: SNOOZE_ID,
    occurrenceId: OCCURRENCE_ID,
    minutes: 20,
    count: 1,
    createdAt: '2026-08-03T10:05:00.000Z',
    createdByUserId: 'Mom',
    createdByDeviceId: 'device-a',
    syncStatus: 'synced',
    ...overrides,
  };
}

function intakeLog(overrides: Record<string, unknown> = {}) {
  return {
    id: LOG_ID,
    patientId: SINGLE_PATIENT_ID,
    medicineId: MEDICINE_ID,
    type: 'prn',
    status: 'taken',
    actualTime: '2026-08-03T10:00:00.000Z',
    quantityTaken: 1,
    loggedByUserId: 'Mom',
    loggedByDeviceId: 'device-a',
    syncStatus: 'synced',
    ...overrides,
  };
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM intake_logs'),
    env.DB.prepare('DELETE FROM inventory_adjustments'),
    env.DB.prepare('DELETE FROM dose_snoozes'),
    env.DB.prepare('DELETE FROM medicines'),
    env.DB.prepare('DELETE FROM join_attempts'),
    env.DB.prepare('DELETE FROM join_codes'),
    env.DB.prepare('DELETE FROM devices'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare('DELETE FROM households'),
  ]);
});

describe('authentication', () => {
  it('refuses every sync route without a valid token', async () => {
    for (const path of ['/sync/bootstrap', '/sync/pull', '/sync/push']) {
      const response = await SELF.fetch(`${BASE}${path}`, { method: path === '/sync/push' ? 'POST' : 'GET' });
      expect(response.status).toBe(401);
    }
  });
});

describe('push and pull', () => {
  it('accepts a record and returns it on a later pull', async () => {
    const session = await createHousehold();

    const pushed = await push(session, [{ table: 'medicines', record: medicine() }]);
    expect(pushed.status).toBe(200);
    expect(pushed.body.results).toEqual([
      { table: 'medicines', id: MEDICINE_ID, outcome: 'applied' },
    ]);

    const pulled = await pull(session, 0);
    expect(pulled.body.records).toHaveLength(1);
    expect(pulled.body.records[0]!).toMatchObject({ table: 'medicines', id: MEDICINE_ID });
    expect(pulled.body.records[0]!.payload).toMatchObject({ name: 'Ondansetron' });
  });

  it('returns nothing for a cursor that is already current', async () => {
    const session = await createHousehold();
    await push(session, [{ table: 'medicines', record: medicine() }]);

    const first = await pull(session, 0);
    const second = await pull(session, first.body.cursor);

    expect(second.body.records).toEqual([]);
    expect(second.body.cursor).toBe(first.body.cursor);
  });

  it('advances the cursor on every accepted write, so nothing is skipped', async () => {
    const session = await createHousehold();

    await push(session, [{ table: 'medicines', record: medicine() }]);
    const afterFirst = await pull(session, 0);

    await push(session, [{ table: 'intakeLogs', record: intakeLog() }]);
    const afterSecond = await pull(session, afterFirst.body.cursor);

    expect(afterSecond.body.records).toHaveLength(1);
    expect(afterSecond.body.records[0]!).toMatchObject({ table: 'intakeLogs' });
    expect(afterSecond.body.cursor).toBeGreaterThan(afterFirst.body.cursor);
  });

  it('bootstraps a new device with everything, plus a resumable cursor', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'medicines', record: medicine() },
      { table: 'intakeLogs', record: intakeLog() },
    ]);

    const response = await SELF.fetch(`${BASE}/sync/bootstrap`, authed(session));
    const body = (await response.json()) as SyncResponse;

    expect(response.status).toBe(200);
    expect(body.records).toHaveLength(2);
    expect(body.cursor).toBeGreaterThan(0);

    // Pulling from the bootstrap cursor yields nothing new — the device is genuinely caught up.
    const delta = await pull(session, body.cursor);
    expect(delta.body.records).toEqual([]);
  });

  it('rejects a non-numeric cursor rather than silently treating it as zero', async () => {
    const session = await createHousehold();
    const response = await SELF.fetch(`${BASE}/sync/pull?cursor=abc`, authed(session));
    expect(response.status).toBe(400);
  });
});

describe('idempotent replay — the difference between a resent request and a second dose', () => {
  it('applies a replayed intake log exactly once', async () => {
    const session = await createHousehold();
    await push(session, [{ table: 'medicines', record: medicine() }]);
    const batch = [{ table: 'intakeLogs', record: intakeLog() }];

    const first = await push(session, batch);
    const second = await push(session, batch);
    const third = await push(session, batch);

    expect(first.body.results[0]!).toMatchObject({ outcome: 'applied' });
    expect(second.body.results[0]!).toMatchObject({ outcome: 'duplicate' });
    expect(third.body.results[0]!).toMatchObject({ outcome: 'duplicate' });

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM intake_logs').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('never lets a replayed log overwrite the stored one, even if the resend differs', async () => {
    const session = await createHousehold();

    await push(session, [{ table: 'medicines', record: medicine() }]);
    await push(session, [{ table: 'intakeLogs', record: intakeLog({ quantityTaken: 1 }) }]);
    // A tampered or buggy resend claiming a different quantity under the same id.
    await push(session, [{ table: 'intakeLogs', record: intakeLog({ quantityTaken: 99 }) }]);

    const row = await env.DB.prepare('SELECT quantity_taken FROM intake_logs WHERE id = ?')
      .bind(LOG_ID)
      .first<{ quantity_taken: number }>();
    expect(row?.quantity_taken).toBe(1);
  });

  it('applies a replayed snooze once, so a retry cannot consume a caregiver’s snooze budget', async () => {
    // The bound is "three snoozes per dose", counted as rows. A dropped response retried by the
    // outbox must therefore not land as a second row, or a flaky connection would silently spend
    // a caregiver's deferrals for them.
    const session = await createHousehold();
    const batch = [{ table: 'doseSnoozes', record: doseSnooze() }];

    const first = await push(session, batch);
    const second = await push(session, batch);

    expect(first.body.results[0]!).toMatchObject({ outcome: 'applied' });
    expect(second.body.results[0]!).toMatchObject({ outcome: 'duplicate' });

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM dose_snoozes').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('keeps two caregivers’ concurrent snoozes of the same dose, discarding neither', async () => {
    // The reason this table is append-only rather than last-write-wins: under LWW the second
    // device's snooze would overwrite the first, and the household would have spent two
    // deferrals while the count showed one.
    const session = await createHousehold();

    await push(session, [{ table: 'doseSnoozes', record: doseSnooze({ id: SNOOZE_ID, createdByDeviceId: 'device-a' }) }]);
    await push(session, [
      {
        table: 'doseSnoozes',
        record: doseSnooze({
          id: '55555555-5555-4555-8555-555555555555',
          count: 2,
          createdByDeviceId: 'device-b',
        }),
      },
    ]);

    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM dose_snoozes WHERE occurrence_id = ?',
    )
      .bind(OCCURRENCE_ID)
      .first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('never lets a replayed snooze overwrite the stored one, even if the resend differs', async () => {
    const session = await createHousehold();

    await push(session, [{ table: 'doseSnoozes', record: doseSnooze({ minutes: 20 }) }]);
    // A buggy or tampered resend claiming a far longer deferral under the same id.
    await push(session, [{ table: 'doseSnoozes', record: doseSnooze({ minutes: 600 }) }]);

    const row = await env.DB.prepare('SELECT minutes FROM dose_snoozes WHERE id = ?')
      .bind(SNOOZE_ID)
      .first<{ minutes: number }>();
    expect(row?.minutes).toBe(20);
  });

  it('applies a replayed inventory adjustment once, so stock cannot drift', async () => {
    const session = await createHousehold();
    const adjustment = {
      id: '33333333-3333-4333-8333-333333333333',
      medicineId: MEDICINE_ID,
      delta: -1,
      reason: 'dose',
      createdAt: '2026-08-03T10:00:00.000Z',
      createdByUserId: 'Mom',
      createdByDeviceId: 'device-a',
      syncStatus: 'synced',
    };

    await push(session, [{ table: 'inventoryAdjustments', record: adjustment }]);
    await push(session, [{ table: 'inventoryAdjustments', record: adjustment }]);

    const sum = await env.DB.prepare('SELECT SUM(delta) AS total FROM inventory_adjustments').first<{
      total: number;
    }>();
    expect(sum?.total).toBe(-1);
  });
});

describe('last-write-wins on mutable records', () => {
  it('accepts a newer version and reports the older one as superseded', async () => {
    const session = await createHousehold();

    await push(session, [
      { table: 'medicines', record: medicine({ name: 'Old', updatedAt: '2026-08-03T10:00:00.000Z' }) },
    ]);
    const newer = await push(session, [
      { table: 'medicines', record: medicine({ name: 'New', updatedAt: '2026-08-03T11:00:00.000Z' }) },
    ]);
    const older = await push(session, [
      { table: 'medicines', record: medicine({ name: 'Older', updatedAt: '2026-08-03T09:00:00.000Z' }) },
    ]);

    expect(newer.body.results[0]!).toMatchObject({ outcome: 'applied' });
    expect(older.body.results[0]!).toMatchObject({ outcome: 'superseded' });

    const row = await env.DB.prepare('SELECT name FROM medicines WHERE id = ?')
      .bind(MEDICINE_ID)
      .first<{ name: string }>();
    expect(row?.name).toBe('New');
  });

  it('breaks a same-millisecond tie by device id, so every device agrees', async () => {
    const session = await createHousehold();
    const sameInstant = '2026-08-03T10:00:00.000Z';

    await push(session, [
      { table: 'medicines', record: medicine({ name: 'FromA', updatedAt: sameInstant, updatedByDeviceId: 'device-a' }) },
    ]);
    await push(session, [
      { table: 'medicines', record: medicine({ name: 'FromB', updatedAt: sameInstant, updatedByDeviceId: 'device-b' }) },
    ]);

    // 'device-b' > 'device-a', so B wins regardless of arrival order.
    const row = await env.DB.prepare('SELECT name FROM medicines WHERE id = ?')
      .bind(MEDICINE_ID)
      .first<{ name: string }>();
    expect(row?.name).toBe('FromB');
  });
});

describe('validation', () => {
  it('rejects a malformed record without blocking the rest of the batch', async () => {
    const session = await createHousehold();
    await push(session, [{ table: 'medicines', record: medicine() }]);

    const result = await push(session, [
      { table: 'medicines', record: { id: MEDICINE_ID, name: '' } },
      { table: 'intakeLogs', record: intakeLog() },
    ]);

    expect(result.status).toBe(200);
    expect(result.body.rejected).toHaveLength(1);
    expect(result.body.rejected[0]!).toMatchObject({ table: 'medicines' });
    // The good record still landed — one bad row must not stop a caregiver's doses syncing.
    expect(result.body.results).toEqual([
      { table: 'intakeLogs', id: LOG_ID, outcome: 'applied' },
    ]);
  });

  it('rejects an unknown table name', async () => {
    const session = await createHousehold();
    const result = await push(session, [{ table: 'not_a_table', record: {} }]);
    expect(result.status).toBe(400);
  });

  it('rejects a batch larger than the limit rather than doing unbounded work', async () => {
    const session = await createHousehold();
    const changes = Array.from({ length: 501 }, (_, i) => ({
      table: 'medicines',
      record: medicine({ id: `id-${i}` }),
    }));

    const result = await push(session, changes);
    expect(result.status).toBe(400);
  });

  it('rejects a body that is not JSON', async () => {
    const session = await createHousehold();
    const response = await SELF.fetch(
      `${BASE}/sync/push`,
      authed(session, { method: 'POST', body: 'not json' }),
    );
    expect(response.status).toBe(400);
  });
});

describe('household isolation — where a mistake leaks medical data', () => {
  it('never returns another household\'s records on pull', async () => {
    const alpha = await createHousehold('Alpha', 'AlphaMom');
    const beta = await createHousehold('Beta', 'BetaMom');

    await push(alpha, [{ table: 'medicines', record: medicine({ name: 'AlphaMedicine' }) }]);

    const betaPull = await pull(beta, 0);
    expect(betaPull.body.records).toEqual([]);
  });

  it('never returns another household\'s records on bootstrap', async () => {
    const alpha = await createHousehold('Alpha', 'AlphaMom');
    const beta = await createHousehold('Beta', 'BetaMom');

    await push(alpha, [
      { table: 'medicines', record: medicine() },
      { table: 'intakeLogs', record: intakeLog() },
    ]);

    const response = await SELF.fetch(`${BASE}/sync/bootstrap`, authed(beta));
    const body = (await response.json()) as SyncResponse;
    expect(body.records).toEqual([]);
  });

  it('writes land in the pushing device\'s household, not one named in the payload', async () => {
    const alpha = await createHousehold('Alpha', 'AlphaMom');
    const beta = await createHousehold('Beta', 'BetaMom');

    // A record carrying another household's id, which the server must ignore entirely.
    await push(alpha, [
      { table: 'medicines', record: { ...medicine(), householdId: beta.householdId } },
    ]);

    const inAlpha = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM medicines WHERE household_id = ?',
    )
      .bind(alpha.householdId)
      .first<{ n: number }>();
    const inBeta = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM medicines WHERE household_id = ?',
    )
      .bind(beta.householdId)
      .first<{ n: number }>();

    expect(inAlpha?.n).toBe(1);
    expect(inBeta?.n).toBe(0);
  });

  it('keeps two households on independent cursors', async () => {
    const alpha = await createHousehold('Alpha', 'AlphaMom');
    const beta = await createHousehold('Beta', 'BetaMom');

    await push(alpha, [{ table: 'medicines', record: medicine() }]);
    await push(alpha, [{ table: 'intakeLogs', record: intakeLog() }]);

    const betaPush = await push(beta, [{ table: 'medicines', record: medicine() }]);

    // Beta's first write is seq 1 in its own household, uninfluenced by Alpha's two writes.
    expect(betaPush.body.cursor).toBe(1);
  });

  it('lets a second device in the same household see the first device\'s records', async () => {
    const first = await createHousehold();

    const codeResponse = await SELF.fetch(
      `${BASE}/join-codes`,
      authed(first, { method: 'POST', body: '{}' }),
    );
    const { code } = (await codeResponse.json()) as { code: string };

    const joinResponse = await SELF.fetch(`${BASE}/join-codes/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, displayName: 'Dad' }),
    });
    const second = (await joinResponse.json()) as Session;

    await push(first, [{ table: 'medicines', record: medicine() }]);

    const secondPull = await pull(second, 0);
    expect(secondPull.body.records).toHaveLength(1);
    expect(secondPull.body.records[0]!.payload).toMatchObject({ name: 'Ondansetron' });
  });
});
