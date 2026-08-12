import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SINGLE_PATIENT_ID } from '@medguard/shared';

/**
 * The Durable Object's two Sprint 4 jobs, against real routes, real D1, and a real WebSocket
 * upgrade through workerd — not a mock of either.
 *
 * The race test matters more than anything else in this file: it is the actual proof that the
 * DO's single-threaded processing is what closes delta D2, not just that the cooldown math is
 * right (that part was already 100%-branch tested in packages/shared before this sprint).
 */

const BASE = 'https://example.com/api/v1';
const MEDICINE_ID = '11111111-1111-4111-8111-111111111111';

interface Session {
  deviceToken: string;
  householdId: string;
  userId: string;
  deviceId: string;
}

interface BlockedResult {
  table: string;
  id: string;
  reason?: string;
  availableAtIso?: string;
  msRemaining?: number;
}

interface PushResponse {
  cursor: number;
  results: { table: string; id: string; outcome: string }[];
  blocked: BlockedResult[];
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

async function joinHousehold(session: Session, displayName = 'Dad'): Promise<Session> {
  const codeResponse = await SELF.fetch(`${BASE}/join-codes`, authed(session, { method: 'POST', body: '{}' }));
  const { code } = (await codeResponse.json()) as { code: string };

  const joinResponse = await SELF.fetch(`${BASE}/join-codes/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, displayName }),
  });
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

async function push(session: Session, changes: { table: string; record: unknown }[]): Promise<PushResponse> {
  const response = await SELF.fetch(
    `${BASE}/sync/push`,
    authed(session, { method: 'POST', body: JSON.stringify({ changes }) }),
  );
  return response.json();
}

async function openLive(session: Session): Promise<{ ws: WebSocket; messages: Record<string, unknown>[] }> {
  const response = await SELF.fetch(`${BASE}/live`, {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': session.deviceToken },
  });
  expect(response.status).toBe(101);

  const ws = response.webSocket;
  if (!ws) {
    throw new Error('Expected a WebSocket on the 101 response');
  }
  ws.accept();

  const messages: Record<string, unknown>[] = [];
  ws.addEventListener('message', (event) => {
    messages.push(JSON.parse(event.data as string) as Record<string, unknown>);
  });

  return { ws, messages };
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

function intakeLog(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    patientId: SINGLE_PATIENT_ID,
    medicineId: MEDICINE_ID,
    type: 'prn',
    status: 'taken',
    actualTime: '2026-08-03T10:00:00.000Z',
    quantityTaken: 1,
    loggedByUserId: 'user-mom',
    loggedByDeviceId: 'device-a',
    syncStatus: 'synced',
    ...overrides,
  };
}

/** Looks up how a specific record id was reported, across both the applied and blocked arrays. */
function outcomeFor(response: PushResponse, id: string): string | undefined {
  return response.results.find((r) => r.id === id)?.outcome ?? (response.blocked.some((b) => b.id === id) ? 'blocked' : undefined);
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM intake_logs'),
    env.DB.prepare('DELETE FROM inventory_adjustments'),
    env.DB.prepare('DELETE FROM medicines'),
    env.DB.prepare('DELETE FROM join_attempts'),
    env.DB.prepare('DELETE FROM join_codes'),
    env.DB.prepare('DELETE FROM devices'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare('DELETE FROM households'),
  ]);
});

describe('the double-dose race', () => {
  it('accepts exactly one of two concurrent doses for the same medicine, and blocks the other', async () => {
    const session = await createHousehold();
    const other = await joinHousehold(session);
    await push(session, [{ table: 'medicines', record: medicine() }]);

    const doseA = intakeLog({
      id: 'aaaaaaaa-0000-4000-8000-000000000001',
      actualTime: '2026-08-03T14:00:00.000Z',
      loggedByUserId: 'user-mom',
      loggedByDeviceId: session.deviceId,
    });
    const doseB = intakeLog({
      id: 'bbbbbbbb-0000-4000-8000-000000000002',
      actualTime: '2026-08-03T14:00:05.000Z',
      loggedByUserId: 'user-dad',
      loggedByDeviceId: other.deviceId,
    });

    // Two devices, both seeing the medicine as safe locally, pushing within the same cooldown
    // window — the exact scenario a single serialization point exists to prevent.
    const [resultA, resultB] = await Promise.all([
      push(session, [{ table: 'intakeLogs', record: doseA }]),
      push(other, [{ table: 'intakeLogs', record: doseB }]),
    ]);

    const outcomes = [outcomeFor(resultA, doseA.id), outcomeFor(resultB, doseB.id)].sort();
    expect(outcomes).toEqual(['applied', 'blocked']);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM intake_logs').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('reports the blocking reason and when the dose becomes available', async () => {
    const session = await createHousehold();
    await push(session, [{ table: 'medicines', record: medicine({ minHoursBetweenDoses: 4 }) }]);
    await push(session, [{ table: 'intakeLogs', record: intakeLog({ actualTime: '2026-08-03T14:00:00.000Z' }) }]);

    const second = await push(session, [
      {
        table: 'intakeLogs',
        record: intakeLog({
          id: '33333333-3333-4333-8333-333333333333',
          actualTime: '2026-08-03T14:00:05.000Z',
        }),
      },
    ]);

    expect(second.blocked).toHaveLength(1);
    expect(second.blocked[0]).toMatchObject({ reason: 'cooldown' });
    expect(second.blocked[0]!.availableAtIso).toBe('2026-08-03T18:00:00.000Z');
  });

  it('accepts an explicit override even while blocked, and records it', async () => {
    const session = await createHousehold();
    await push(session, [{ table: 'medicines', record: medicine({ minHoursBetweenDoses: 4 }) }]);
    await push(session, [{ table: 'intakeLogs', record: intakeLog({ actualTime: '2026-08-03T14:00:00.000Z' }) }]);

    const overridden = await push(session, [
      {
        table: 'intakeLogs',
        record: intakeLog({
          id: '44444444-4444-4444-8444-444444444444',
          actualTime: '2026-08-03T14:00:05.000Z',
          override: { confirmedByUserId: 'user-mom', reason: 'Vomiting again', blockedBy: 'cooldown' },
        }),
      },
    ]);

    expect(overridden.blocked).toEqual([]);
    expect(outcomeFor(overridden, '44444444-4444-4444-8444-444444444444')).toBe('applied');

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM intake_logs').first<{ n: number }>();
    expect(count?.n).toBe(2);
  });

  it('never lets an unguarded medicine (no cooldown, no cap) block a second dose', async () => {
    const session = await createHousehold();
    await push(session, [
      { table: 'medicines', record: medicine({ minHoursBetweenDoses: undefined, maxDailyDoses: undefined }) },
    ]);
    await push(session, [{ table: 'intakeLogs', record: intakeLog({ actualTime: '2026-08-03T14:00:00.000Z' }) }]);

    const second = await push(session, [
      {
        table: 'intakeLogs',
        record: intakeLog({
          id: '55555555-5555-4555-8555-555555555555',
          actualTime: '2026-08-03T14:00:05.000Z',
        }),
      },
    ]);

    expect(second.blocked).toEqual([]);
  });

  it('blocks an inventory adjustment whose related dose was blocked in the same batch — stock never moves for a rejected dose', async () => {
    const session = await createHousehold();
    await push(session, [{ table: 'medicines', record: medicine({ minHoursBetweenDoses: 4 }) }]);
    await push(session, [{ table: 'intakeLogs', record: intakeLog({ actualTime: '2026-08-03T14:00:00.000Z' }) }]);

    const blockedLogId = '66666666-6666-4666-8666-666666666666';
    const result = await push(session, [
      { table: 'intakeLogs', record: intakeLog({ id: blockedLogId, actualTime: '2026-08-03T14:00:05.000Z' }) },
      {
        table: 'inventoryAdjustments',
        record: {
          id: '77777777-7777-4777-8777-777777777777',
          medicineId: MEDICINE_ID,
          delta: -1,
          reason: 'dose',
          relatedLogId: blockedLogId,
          createdAt: '2026-08-03T14:00:05.000Z',
          createdByUserId: 'user-mom',
          createdByDeviceId: 'device-a',
          syncStatus: 'synced',
        },
      },
    ]);

    expect(result.blocked.map((b) => b.id).sort()).toEqual(
      [blockedLogId, '77777777-7777-4777-8777-777777777777'].sort(),
    );

    const sum = await env.DB.prepare('SELECT COALESCE(SUM(delta), 0) AS total FROM inventory_adjustments').first<{
      total: number;
    }>();
    expect(sum?.total).toBe(0);
  });

  it('never lets a replayed intake log block itself as its own cooldown violation', async () => {
    const session = await createHousehold();
    await push(session, [{ table: 'medicines', record: medicine({ minHoursBetweenDoses: 4 }) }]);
    const log = intakeLog({ actualTime: '2026-08-03T14:00:00.000Z' });

    const first = await push(session, [{ table: 'intakeLogs', record: log }]);
    const resend = await push(session, [{ table: 'intakeLogs', record: log }]);

    expect(outcomeFor(first, log.id)).toBe('applied');
    expect(outcomeFor(resend, log.id)).toBe('duplicate');
    expect(resend.blocked).toEqual([]);
  });

  it('never lets a dose correction be blocked by the stale timestamp of the log it supersedes', async () => {
    const session = await createHousehold();
    await push(session, [{ table: 'medicines', record: medicine({ minHoursBetweenDoses: 4 }) }]);

    const original = intakeLog({ actualTime: '2026-08-03T14:00:00.000Z' });
    await push(session, [{ table: 'intakeLogs', record: original }]);

    // Correcting the dose 30 minutes earlier: with the original still sitting in comparison
    // history at its later, un-superseded actualTime, the corrected (earlier) "now" would see the
    // original as a future dose still inside the cooldown window and get blocked against itself.
    const corrected = intakeLog({
      id: '99999999-9999-4999-8999-999999999999',
      actualTime: '2026-08-03T13:30:00.000Z',
      supersedesId: original.id,
    });
    const result = await push(session, [{ table: 'intakeLogs', record: corrected }]);

    expect(outcomeFor(result, corrected.id)).toBe('applied');
    expect(result.blocked).toEqual([]);
  });
});

describe('live channel', () => {
  it('refuses a WebSocket upgrade with an invalid or missing device token', async () => {
    for (const protocol of [undefined, 'not-a-real-token']) {
      const response = await SELF.fetch(`${BASE}/live`, {
        headers: {
          Upgrade: 'websocket',
          ...(protocol ? { 'Sec-WebSocket-Protocol': protocol } : {}),
        },
      });
      expect(response.status).toBe(401);
    }
  });

  it('refuses a non-upgrade request even with a valid token', async () => {
    const session = await createHousehold();
    const response = await SELF.fetch(`${BASE}/live`, {
      headers: { 'Sec-WebSocket-Protocol': session.deviceToken },
    });
    expect(response.status).toBe(426);
  });

  it('broadcasts a sync message to every device in the household when a change is accepted', async () => {
    const session = await createHousehold();
    const other = await joinHousehold(session);

    const a = await openLive(session);
    const b = await openLive(other);

    await push(session, [{ table: 'medicines', record: medicine() }]);

    await vi.waitFor(() => {
      expect(a.messages).toContainEqual({ type: 'sync', cursor: 1 });
      expect(b.messages).toContainEqual({ type: 'sync', cursor: 1 });
    });
  });

  it('never lets a device from another household see this household\'s broadcasts', async () => {
    const alpha = await createHousehold('Alpha');
    const beta = await createHousehold('Beta');

    const betaLive = await openLive(beta);
    await push(alpha, [{ table: 'medicines', record: medicine() }]);

    // Give a stray cross-household message a real chance to arrive before asserting its absence.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(betaLive.messages).toEqual([]);
  });

  it('broadcasts a safety.warning to every connected device — not just the one that attempted the dose', async () => {
    const session = await createHousehold();
    const other = await joinHousehold(session);
    await push(session, [{ table: 'medicines', record: medicine({ minHoursBetweenDoses: 4 }) }]);
    await push(session, [{ table: 'intakeLogs', record: intakeLog({ actualTime: '2026-08-03T14:00:00.000Z' }) }]);

    const observer = await openLive(other);

    await push(session, [
      {
        table: 'intakeLogs',
        record: intakeLog({
          id: '88888888-8888-4888-8888-888888888888',
          actualTime: '2026-08-03T14:00:05.000Z',
        }),
      },
    ]);

    await vi.waitFor(() => {
      expect(observer.messages).toContainEqual({
        type: 'safety.warning',
        medicineId: MEDICINE_ID,
        blockedBy: 'cooldown',
        attemptedByUserId: 'user-mom',
        outcome: 'blocked',
      });
    });
  });
});
