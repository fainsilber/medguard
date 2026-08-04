import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import type { Medicine } from '@medguard/shared';
import { MedGuardRepository } from '../db/repository.js';
import { MedGuardDB } from '../db/schema.js';
import { getCursor } from './cursor.js';
import { SyncEngine } from './engine.js';

/**
 * The sync engine, against a real (fake-indexeddb) Dexie database and a mocked fetch.
 *
 * The behaviors under test here are what makes the outbox and the local database actually
 * trustworthy: a blocked or duplicate push must not get stuck retrying forever, a pull must
 * never clobber an edit the server hasn't acknowledged yet, and the cursor has to actually
 * advance so the same records aren't re-applied every time.
 */

let dbCounter = 0;
const API_BASE = 'https://example.com';
const DEVICE_TOKEN = 'tok-1';
const HOUSEHOLD_ID = 'household-1';
const MEDICINE_ID = '11111111-1111-4111-8111-111111111111';

function medicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: MEDICINE_ID,
    patientId: SINGLE_PATIENT_ID,
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: true,
    archived: false,
    updatedAt: '2026-08-03T10:00:00.000Z',
    updatedByDeviceId: 'device-a',
    syncStatus: 'pending',
    ...overrides,
  };
}

function setup() {
  const db = new MedGuardDB(`SyncEngineTest-${(dbCounter += 1)}`);
  const repository = new MedGuardRepository(db, {
    clock: fixedClock('2026-08-03T12:00:00.000Z'),
    ids: sequentialIds('id'),
    userId: 'user-mom',
    deviceId: 'device-a',
  });
  const engine = new SyncEngine({
    db,
    repository,
    apiBaseUrl: API_BASE,
    deviceToken: DEVICE_TOKEN,
    householdId: HOUSEHOLD_ID,
  });
  return { db, repository, engine };
}

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(handler));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('drainOutbox', () => {
  it('marks an applied push synced, both in the outbox and on the local record', async () => {
    const { db, repository, engine } = setup();
    await repository.saveMedicine(medicine(), 'CREATE');

    stubFetch((url) =>
      url.includes('/sync/push')
        ? jsonResponse({
            cursor: 1,
            results: [{ table: 'medicines', id: MEDICINE_ID, outcome: 'applied' }],
            blocked: [],
            rejected: [],
          })
        : jsonResponse({ error: 'unexpected_url' }, 404),
    );

    const outcome = await engine.drainOutbox();

    expect(outcome).toEqual({ pushed: 1, blocked: 0 });
    expect(await repository.pendingSyncCount()).toBe(0);
    const stored = await db.medicines.get(MEDICINE_ID);
    expect(stored?.syncStatus).toBe('synced');
  });

  it('removes a blocked entry from the outbox rather than retrying it forever', async () => {
    const { repository, engine } = setup();
    await repository.saveMedicine(medicine(), 'CREATE');

    stubFetch((url) =>
      url.includes('/sync/push')
        ? jsonResponse({
            cursor: 0,
            results: [],
            blocked: [{ table: 'medicines', id: MEDICINE_ID, reason: 'cooldown' }],
            rejected: [],
          })
        : jsonResponse({ error: 'unexpected_url' }, 404),
    );

    const outcome = await engine.drainOutbox();

    expect(outcome).toEqual({ pushed: 0, blocked: 1 });
    expect(await repository.pendingSyncCount()).toBe(0);
  });

  it('keeps a rejected entry queued, with the failure recorded, rather than silently dropping it', async () => {
    const { repository, engine } = setup();
    await repository.saveMedicine(medicine(), 'CREATE');

    stubFetch((url) =>
      url.includes('/sync/push')
        ? jsonResponse({
            cursor: 0,
            results: [],
            blocked: [],
            rejected: [{ table: 'medicines', id: MEDICINE_ID, issues: [] }],
          })
        : jsonResponse({ error: 'unexpected_url' }, 404),
    );

    await engine.drainOutbox();

    expect(await repository.pendingSyncCount()).toBe(1);
    const [entry] = await repository.pendingSync();
    expect(entry!.lastError).toMatch(/rejected/i);
  });

  it('leaves every entry queued and throws on a network failure, rather than assuming any outcome', async () => {
    const { repository, engine } = setup();
    await repository.saveMedicine(medicine(), 'CREATE');

    stubFetch(() => {
      throw new TypeError('network down');
    });

    await expect(engine.drainOutbox()).rejects.toThrow();
    expect(await repository.pendingSyncCount()).toBe(1);
  });
});

describe('pull', () => {
  it('bootstraps on the first pull and stores the cursor', async () => {
    const { db, engine } = setup();

    stubFetch((url) =>
      url.includes('/sync/bootstrap')
        ? jsonResponse({
            cursor: 3,
            records: [{ table: 'medicines', id: MEDICINE_ID, seq: 3, payload: medicine({ syncStatus: 'pending' }) }],
          })
        : jsonResponse({ error: 'unexpected_url' }, 404),
    );

    await engine.pull();

    const stored = await db.medicines.get(MEDICINE_ID);
    expect(stored).toMatchObject({ name: 'Ondansetron', syncStatus: 'synced' });
    expect(await getCursor(db, HOUSEHOLD_ID)).toBe(3);
  });

  it('pulls by cursor once one is already stored, not by bootstrapping again', async () => {
    const { db, engine } = setup();
    const { setCursor } = await import('./cursor.js');
    await setCursor(db, HOUSEHOLD_ID, 5);

    let pulledUrl = '';
    stubFetch((url) => {
      pulledUrl = url;
      return jsonResponse({ cursor: 5, records: [], hasMore: false });
    });

    await engine.pull();

    expect(pulledUrl).toContain('/sync/pull?cursor=5');
  });

  it('never lets a pull clobber a local edit the server has not acknowledged yet', async () => {
    const { db, repository, engine } = setup();
    await repository.saveMedicine(medicine({ name: 'Local edit' }), 'UPDATE');
    // Still 'pending' — never pushed.

    stubFetch((url) =>
      url.includes('/sync/bootstrap')
        ? jsonResponse({
            cursor: 1,
            records: [
              {
                table: 'medicines',
                id: MEDICINE_ID,
                seq: 1,
                payload: medicine({ name: 'Stale remote version', syncStatus: 'synced' }),
              },
            ],
          })
        : jsonResponse({ error: 'unexpected_url' }, 404),
    );

    await engine.pull();

    const stored = await db.medicines.get(MEDICINE_ID);
    expect(stored?.name).toBe('Local edit');
  });

  it('follows hasMore across pages until fully caught up', async () => {
    const { db, engine } = setup();
    const secondId = '22222222-2222-4222-8222-222222222222';
    let call = 0;

    stubFetch((url) => {
      if (!url.includes('/sync/bootstrap') && !url.includes('/sync/pull')) {
        return jsonResponse({ error: 'unexpected_url' }, 404);
      }
      call += 1;
      if (call === 1) {
        return jsonResponse({
          cursor: 1,
          records: [{ table: 'medicines', id: MEDICINE_ID, seq: 1, payload: medicine() }],
          hasMore: true,
        });
      }
      return jsonResponse({
        cursor: 2,
        records: [{ table: 'medicines', id: secondId, seq: 2, payload: medicine({ id: secondId, name: 'Second' }) }],
        hasMore: false,
      });
    });

    await engine.pull();

    expect(await db.medicines.count()).toBe(2);
    expect(await getCursor(db, HOUSEHOLD_ID)).toBe(2);
  });

  it('applies an append-only record once and leaves a re-pulled duplicate untouched', async () => {
    const { db, engine } = setup();
    const logId = '33333333-3333-4333-8333-333333333333';
    const log = {
      id: logId,
      patientId: SINGLE_PATIENT_ID,
      medicineId: MEDICINE_ID,
      type: 'prn',
      status: 'taken',
      actualTime: '2026-08-03T10:00:00.000Z',
      quantityTaken: 1,
      loggedByUserId: 'user-mom',
      loggedByDeviceId: 'device-a',
      syncStatus: 'pending',
    };

    stubFetch((url) =>
      url.includes('/sync/bootstrap') || url.includes('/sync/pull')
        ? jsonResponse({ cursor: 1, records: [{ table: 'intakeLogs', id: logId, seq: 1, payload: log }] })
        : jsonResponse({ error: 'unexpected_url' }, 404),
    );

    await engine.pull();
    expect(await db.intakeLogs.count()).toBe(1);

    // A second pull re-delivering the same record (e.g. a delta pull whose cursor didn't move
    // past it) must not duplicate it — the append-only path is a no-op once the id exists locally.
    await engine.pull();

    expect(await db.intakeLogs.count()).toBe(1);
  });
});

describe('runOnce', () => {
  it('drains before pulling, so a device never re-downloads what it just uploaded as if it were remote', async () => {
    const { repository, engine } = setup();
    await repository.saveMedicine(medicine(), 'CREATE');

    const calls: string[] = [];
    stubFetch((url) => {
      calls.push(url);
      if (url.includes('/sync/push')) {
        return jsonResponse({
          cursor: 1,
          results: [{ table: 'medicines', id: MEDICINE_ID, outcome: 'applied' }],
          blocked: [],
          rejected: [],
        });
      }
      return jsonResponse({ cursor: 1, records: [], hasMore: false });
    });

    await engine.runOnce();

    expect(calls[0]).toContain('/sync/push');
    expect(calls.some((url) => url.includes('/sync/pull') || url.includes('/sync/bootstrap'))).toBe(true);
  });
});
