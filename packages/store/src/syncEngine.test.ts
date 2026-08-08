import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import type { Medicine } from '@medguard/shared';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import { DexieStore } from './dexie/dexieStore.js';
import { MedGuardRepository } from './repository.js';
import { getCursor, setCursor } from './cursor.js';
import { SyncApiError, SyncEngine } from './syncEngine.js';
import type { SyncApi, SyncApiResult, SyncPullResult, SyncPushResult } from './syncEngine.js';

/**
 * The sync engine, against a real (fake-indexeddb) Dexie-backed store and a stubbed `SyncApi` —
 * no `fetch` involved, since Sprint A1 made the HTTP half an injected dependency
 * (`apps/web/src/api/syncApi.ts` supplies the real one; Android will supply its own). Ported from
 * `apps/web/src/sync/engine.test.ts`, same behaviors, now against the storage-agnostic engine.
 */

class TestDB extends Dexie {
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      householdSettings: 'id',
      medicines: 'id, patientId, name, archived, syncStatus, updatedAt',
      schedules: 'id, medicineId, patientId, active, regimenGroupId, syncStatus, updatedAt',
      intakeLogs:
        'id, patientId, medicineId, scheduleId, status, type, actualTime, syncStatus, supersedesId, [medicineId+actualTime], [patientId+actualTime]',
      inventoryItems: 'id, medicineId, syncStatus, updatedAt',
      inventoryAdjustments: 'id, medicineId, relatedLogId, createdAt, syncStatus',
      shabbatConfig: 'id, patientId',
      syncOutbox: '++id, table, entityId, action, createdAt',
      syncMeta: 'key',
    });
  }
}

let dbCounter = 0;
const openDatabases: { delete(): Promise<unknown> }[] = [];
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

/** A fake `SyncApi` — each test wires up only the calls it expects, and `unexpected_url`-shaped
 * fallbacks are simply omitted, since there is no URL to route on anymore. */
function fakeApi(overrides: Partial<SyncApi> = {}): SyncApi {
  const notConfigured = (name: string) => () => {
    throw new Error(`fakeApi.${name} was not configured for this test`);
  };
  return {
    bootstrap: overrides.bootstrap ?? notConfigured('bootstrap'),
    pull: overrides.pull ?? notConfigured('pull'),
    pushChanges: overrides.pushChanges ?? notConfigured('pushChanges'),
  };
}

function ok<T>(value: T): SyncApiResult<T> {
  return { ok: true, value };
}

function setup(api: SyncApi) {
  const db = new TestDB(`SyncEngineTest-${(dbCounter += 1)}`);
  openDatabases.push(db);
  const store = new DexieStore(db);
  const repository = new MedGuardRepository(store, {
    clock: fixedClock('2026-08-03T12:00:00.000Z'),
    ids: sequentialIds('id'),
    userId: 'user-mom',
    deviceId: 'device-a',
  });
  const engine = new SyncEngine({
    store,
    repository,
    api,
    apiBaseUrl: API_BASE,
    deviceToken: DEVICE_TOKEN,
    householdId: HOUSEHOLD_ID,
  });
  return { db, store, repository, engine };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of openDatabases) {
    await db.delete();
  }
  openDatabases.length = 0;
});

describe('drainOutbox', () => {
  it('marks an applied push synced, both in the outbox and on the local record', async () => {
    const api = fakeApi({
      pushChanges: async (): Promise<SyncApiResult<SyncPushResult>> =>
        ok({ results: [{ id: MEDICINE_ID }], blocked: [], rejected: [] }),
    });
    const { db, repository, engine } = setup(api);
    await repository.saveMedicine(medicine(), 'CREATE');

    const outcome = await engine.drainOutbox();

    expect(outcome).toEqual({ pushed: 1, blocked: 0 });
    expect(await repository.pendingSyncCount()).toBe(0);
    const stored = await db.table('medicines').get(MEDICINE_ID);
    expect(stored?.syncStatus).toBe('synced');
  });

  it('removes a blocked entry from the outbox rather than retrying it forever', async () => {
    const api = fakeApi({
      pushChanges: async (): Promise<SyncApiResult<SyncPushResult>> =>
        ok({ results: [], blocked: [{ id: MEDICINE_ID }], rejected: [] }),
    });
    const { repository, engine } = setup(api);
    await repository.saveMedicine(medicine(), 'CREATE');

    const outcome = await engine.drainOutbox();

    expect(outcome).toEqual({ pushed: 0, blocked: 1 });
    expect(await repository.pendingSyncCount()).toBe(0);
  });

  it('keeps a rejected entry queued, with the failure recorded, rather than silently dropping it', async () => {
    const api = fakeApi({
      pushChanges: async (): Promise<SyncApiResult<SyncPushResult>> =>
        ok({ results: [], blocked: [], rejected: [{ id: MEDICINE_ID }] }),
    });
    const { repository, engine } = setup(api);
    await repository.saveMedicine(medicine(), 'CREATE');

    await engine.drainOutbox();

    expect(await repository.pendingSyncCount()).toBe(1);
    const [entry] = await repository.pendingSync();
    expect(entry!.lastError).toMatch(/rejected/i);
  });

  it('leaves every entry queued and throws on a network failure, rather than assuming any outcome', async () => {
    const api = fakeApi({
      pushChanges: async (): Promise<SyncApiResult<SyncPushResult>> => ({ ok: false, error: 'network down' }),
    });
    const { repository, engine } = setup(api);
    await repository.saveMedicine(medicine(), 'CREATE');

    await expect(engine.drainOutbox()).rejects.toThrow();
    expect(await repository.pendingSyncCount()).toBe(1);
  });

  it('throws a SyncApiError carrying the server code, so a caller can tell a revoked device apart from any other failure', async () => {
    const api = fakeApi({
      pushChanges: async (): Promise<SyncApiResult<SyncPushResult>> => ({
        ok: false,
        error: 'This device is no longer signed in to a household.',
        code: 'unauthorized',
      }),
    });
    const { repository, engine } = setup(api);
    await repository.saveMedicine(medicine(), 'CREATE');

    const rejection = engine.drainOutbox();
    await expect(rejection).rejects.toBeInstanceOf(SyncApiError);
    await rejection.catch((err: unknown) => {
      expect(err).toBeInstanceOf(SyncApiError);
      expect((err as SyncApiError).code).toBe('unauthorized');
    });
  });
});

describe('pull', () => {
  it('bootstraps on the first pull and stores the cursor', async () => {
    const api = fakeApi({
      bootstrap: async (): Promise<SyncApiResult<SyncPullResult>> =>
        ok({
          cursor: 3,
          records: [{ table: 'medicines', id: MEDICINE_ID, payload: medicine({ syncStatus: 'pending' }) }],
        }),
    });
    const { db, store, engine } = setup(api);

    await engine.pull();

    const stored = await db.table('medicines').get(MEDICINE_ID);
    expect(stored).toMatchObject({ name: 'Ondansetron', syncStatus: 'synced' });
    expect(await getCursor(store, HOUSEHOLD_ID)).toBe(3);
  });

  it('pulls by cursor once one is already stored, not by bootstrapping again', async () => {
    let pulledCursor: number | undefined;
    const api = fakeApi({
      pull: async (_url, _token, cursor): Promise<SyncApiResult<SyncPullResult>> => {
        pulledCursor = cursor;
        return ok({ cursor: 5, records: [], hasMore: false });
      },
    });
    const { store, engine } = setup(api);
    await setCursor(store, HOUSEHOLD_ID, 5);

    await engine.pull();

    expect(pulledCursor).toBe(5);
  });

  it('never lets a pull clobber a local edit the server has not acknowledged yet', async () => {
    const api = fakeApi({
      bootstrap: async (): Promise<SyncApiResult<SyncPullResult>> =>
        ok({
          cursor: 1,
          records: [
            { table: 'medicines', id: MEDICINE_ID, payload: medicine({ name: 'Stale remote version', syncStatus: 'synced' }) },
          ],
        }),
    });
    const { db, repository, engine } = setup(api);
    await repository.saveMedicine(medicine({ name: 'Local edit' }), 'UPDATE');
    // Still 'pending' — never pushed.

    await engine.pull();

    const stored = await db.table('medicines').get(MEDICINE_ID);
    expect(stored?.name).toBe('Local edit');
  });

  it('merges an incoming update onto an already-synced local record via last-write-wins', async () => {
    const api = fakeApi({
      bootstrap: async (): Promise<SyncApiResult<SyncPullResult>> =>
        ok({
          cursor: 1,
          records: [
            {
              table: 'medicines',
              id: MEDICINE_ID,
              payload: medicine({ name: 'Newer remote version', updatedAt: '2026-08-04T00:00:00.000Z', syncStatus: 'synced' }),
            },
          ],
        }),
    });
    const { db, engine } = setup(api);
    // No pending edit — `hasPendingChanges` is false, so this exercises the actual
    // `mergeLww`-and-write path rather than the "leave it alone" early return above.
    await db.table('medicines').put(medicine({ name: 'Older local version', syncStatus: 'synced' }));

    await engine.pull();

    const stored = await db.table('medicines').get(MEDICINE_ID);
    expect(stored?.name).toBe('Newer remote version');
    expect(stored?.syncStatus).toBe('synced');
  });

  it('follows hasMore across pages until fully caught up', async () => {
    const secondId = '22222222-2222-4222-8222-222222222222';
    let call = 0;
    const api = fakeApi({
      bootstrap: async (): Promise<SyncApiResult<SyncPullResult>> => {
        call += 1;
        if (call === 1) {
          return ok({ cursor: 1, records: [{ table: 'medicines', id: MEDICINE_ID, payload: medicine() }], hasMore: true });
        }
        return ok({
          cursor: 2,
          records: [{ table: 'medicines', id: secondId, payload: medicine({ id: secondId, name: 'Second' }) }],
          hasMore: false,
        });
      },
      pull: async (): Promise<SyncApiResult<SyncPullResult>> => {
        call += 1;
        return ok({
          cursor: 2,
          records: [{ table: 'medicines', id: secondId, payload: medicine({ id: secondId, name: 'Second' }) }],
          hasMore: false,
        });
      },
    });
    const { db, store, engine } = setup(api);

    await engine.pull();

    expect(await db.table('medicines').count()).toBe(2);
    expect(await getCursor(store, HOUSEHOLD_ID)).toBe(2);
  });

  it('applies an append-only record once and leaves a re-pulled duplicate untouched', async () => {
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
    const response = async (): Promise<SyncApiResult<SyncPullResult>> =>
      ok({ cursor: 1, records: [{ table: 'intakeLogs', id: logId, payload: log }] });
    const api = fakeApi({ bootstrap: response, pull: response });
    const { db, engine } = setup(api);

    await engine.pull();
    expect(await db.table('intakeLogs').count()).toBe(1);

    // A second pull re-delivering the same record (e.g. a delta pull whose cursor didn't move
    // past it) must not duplicate it — the append-only path is a no-op once the id exists locally.
    await engine.pull();

    expect(await db.table('intakeLogs').count()).toBe(1);
  });

  it('throws a SyncApiError carrying the server code on a failed bootstrap/pull, same as drainOutbox', async () => {
    const api = fakeApi({
      bootstrap: async (): Promise<SyncApiResult<SyncPullResult>> => ({
        ok: false,
        error: 'This device is no longer signed in to a household.',
        code: 'unauthorized',
      }),
    });
    const { engine } = setup(api);

    const rejection = engine.pull();
    await expect(rejection).rejects.toBeInstanceOf(SyncApiError);
    await rejection.catch((err: unknown) => {
      expect((err as SyncApiError).code).toBe('unauthorized');
    });
  });
});

describe('runOnce', () => {
  it('drains before pulling, so a device never re-downloads what it just uploaded as if it were remote', async () => {
    const calls: string[] = [];
    const api = fakeApi({
      pushChanges: async (): Promise<SyncApiResult<SyncPushResult>> => {
        calls.push('push');
        return ok({ results: [{ id: MEDICINE_ID }], blocked: [], rejected: [] });
      },
      bootstrap: async (): Promise<SyncApiResult<SyncPullResult>> => {
        calls.push('pull');
        return ok({ cursor: 1, records: [], hasMore: false });
      },
    });
    const { repository, engine } = setup(api);
    await repository.saveMedicine(medicine(), 'CREATE');

    await engine.runOnce();

    expect(calls[0]).toBe('push');
    expect(calls).toContain('pull');
  });

  it('coalesces concurrent calls instead of letting their transactions race', async () => {
    // Regression for the Android crash where mount, a new outbox entry, and the live socket's
    // 'open' event all called runOnce() in the same tick: `expo-sqlite`'s single connection
    // rejects a second `BEGIN` while one is already open. Any overlap here — not just a specific
    // call count — is the bug, so this asserts on concurrency rather than on how many network
    // calls happened.
    let inFlight = 0;
    let maxInFlight = 0;
    const trackedPull = async (): Promise<SyncApiResult<SyncPullResult>> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight -= 1;
      return ok({ cursor: 1, records: [], hasMore: false });
    };
    const api = fakeApi({ bootstrap: trackedPull, pull: trackedPull });
    const { engine } = setup(api);

    await Promise.all([engine.runOnce(), engine.runOnce(), engine.runOnce()]);

    expect(maxInFlight).toBe(1);
  });
});
