import { SINGLE_PATIENT_ID } from '@medguard/shared';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import { MedGuardRepository } from '@medguard/store';
import { SqliteStore } from '@medguard/store/sqlite';

/**
 * `backgroundSync.ts` is what WorkManager runs when the app is closed: one sync round against the
 * same `medguard.db` the app uses, with no component tree. Properties that matter, in order:
 *
 * 1. **It syncs what is waiting** — an outbox record is pushed with the household's token.
 * 2. **It never double-runs against a live app** — a mounted `SyncProvider`'s runner is used
 *    instead of a second engine.
 * 3. **It never throws** — a rejection in a background worker is a crash on a locked phone; a
 *    failed round is reported to the worker as `Failed` so the next scheduled run is the retry.
 * 4. **Scheduling is safe to call anywhere** — idempotent, and a platform refusal is logged only.
 *
 * The module graph is reset per test (as `headlessTask.test.tsx` does) because the database name
 * is fixed, so each test gets a fresh in-memory database and identity store.
 */

jest.mock('expo-background-task', () => ({
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  getStatusAsync: jest.fn().mockResolvedValue(2),
  registerTaskAsync: jest.fn().mockResolvedValue(undefined),
  unregisterTaskAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn().mockResolvedValue(true),
  getTaskOptionsAsync: jest.fn().mockResolvedValue({ minimumInterval: 15 }),
}));

const NOW_ISO = '2026-08-03T10:00:00.000Z';
const SESSION = { deviceToken: 'tok-bg', householdId: 'h1', userId: 'u1', deviceId: 'd1' };

function fresh() {
  jest.resetModules();
  const sqlite = require('expo-sqlite') as typeof import('expo-sqlite');
  const session = require('../identity/session.js') as typeof import('../identity/session.js');
  const caregiverName = require('../identity/caregiverName.js') as typeof import(
    '../identity/caregiverName.js'
  );
  const bg = require('./backgroundSync.js') as typeof import('./backgroundSync.js');
  const interval = require('./syncInterval.js') as typeof import('./syncInterval.js');
  const BackgroundTask = require('expo-background-task') as jest.Mocked<
    typeof import('expo-background-task')
  >;
  const TaskManager = require('expo-task-manager') as jest.Mocked<
    typeof import('expo-task-manager')
  >;
  return { sqlite, session, caregiverName, bg, interval, BackgroundTask, TaskManager };
}

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const fetchMock = jest.fn(async (url: string) => handler(url));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

async function queueMedicine(sqlite: typeof import('expo-sqlite')) {
  const { ExpoSqliteDriver, createSqliteSchema } = require('../store/expoSqliteDriver.js') as typeof import(
    '../store/expoSqliteDriver.js'
  );
  const db = await sqlite.openDatabaseAsync('medguard.db');
  await createSqliteSchema(db);
  const repository = new MedGuardRepository(new SqliteStore(new ExpoSqliteDriver(db)), {
    clock: fixedClock(NOW_ISO),
    ids: sequentialIds('seed'),
    userId: 'mom',
    deviceId: 'd1',
  });
  await repository.saveMedicine(
    {
      id: 'm1',
      patientId: SINGLE_PATIENT_ID,
      name: 'Ondansetron',
      strength: '4mg',
      form: 'pill',
      asNeeded: true,
      archived: false,
      updatedAt: NOW_ISO,
      updatedByDeviceId: 'd1',
      syncStatus: 'pending',
    },
    'CREATE',
  );
  return repository;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('runBackgroundSync', () => {
  it('does nothing when this device belongs to no household', async () => {
    const { bg } = fresh();
    const fetchMock = stubFetch(() => ok({}));

    await expect(bg.runBackgroundSync()).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when no caregiver has identified themselves on this device', async () => {
    const { bg, session } = fresh();
    await session.setHouseholdSession(SESSION);
    const fetchMock = stubFetch(() => ok({}));

    await expect(bg.runBackgroundSync()).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pushes the outbox and pulls with the household token', async () => {
    const { bg, session, caregiverName, sqlite } = fresh();
    await session.setHouseholdSession(SESSION);
    await caregiverName.setCaregiverName('mom');
    const repository = await queueMedicine(sqlite);
    expect(await repository.pendingSyncCount()).toBe(1);

    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchMock = stubFetch((url) => {
      calls.push({ url });
      if (url.includes('/sync/push')) {
        return ok({
          cursor: 1,
          results: [{ table: 'medicines', id: 'm1', outcome: 'applied' }],
          blocked: [],
          rejected: [],
        });
      }
      return ok({ cursor: 1, records: [], hasMore: false });
    });

    await expect(bg.runBackgroundSync()).resolves.toBe(true);

    expect(calls.some((c) => c.url.includes('/sync/push'))).toBe(true);
    expect(calls.some((c) => /\/sync\/(pull|bootstrap)/.test(c.url))).toBe(true);
    const init = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init[1].headers as Record<string, string>).Authorization).toBe('Bearer tok-bg');
    expect(await repository.pendingSyncCount()).toBe(0);
  });

  it('runs through the mounted SyncProvider instead of opening a second engine', async () => {
    const { bg, session, caregiverName } = fresh();
    await session.setHouseholdSession(SESSION);
    await caregiverName.setCaregiverName('mom');
    const fetchMock = stubFetch(() => ok({}));
    const runner = jest.fn().mockResolvedValue(undefined);

    bg.setForegroundSyncRunner(runner);
    await expect(bg.runBackgroundSync()).resolves.toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    // Once the provider unmounts, the worker is on its own again.
    bg.setForegroundSyncRunner(null);
    stubFetch(() => ok({ cursor: 0, records: [], hasMore: false }));
    await bg.runBackgroundSync();
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('reports a failed round as false instead of throwing', async () => {
    const { bg, session, caregiverName, sqlite } = fresh();
    await session.setHouseholdSession(SESSION);
    await caregiverName.setCaregiverName('mom');
    const repository = await queueMedicine(sqlite);
    stubFetch(() => {
      throw new Error('network down');
    });

    await expect(bg.runBackgroundSync()).resolves.toBe(false);
    // The write is still queued for the next run — nothing was lost.
    expect(await repository.pendingSyncCount()).toBe(1);
  });
});

describe('background task registration', () => {
  it('defines a task whose result tells WorkManager whether the round worked', async () => {
    const { bg, TaskManager } = fresh();
    bg.defineBackgroundSyncTask();

    expect(TaskManager.defineTask).toHaveBeenCalledWith('MedGuardBackgroundSync', expect.any(Function));
    const executor = TaskManager.defineTask.mock.calls[0]![1] as () => Promise<number>;

    // No session: nothing to do counts as success.
    await expect(executor()).resolves.toBe(1);
  });

  it('registers at the default 15 minutes, and tolerates a platform refusal', async () => {
    const { bg, BackgroundTask, TaskManager } = fresh();
    TaskManager.isTaskRegisteredAsync.mockResolvedValue(false);

    await bg.registerBackgroundSync();
    expect(BackgroundTask.registerTaskAsync).toHaveBeenCalledWith('MedGuardBackgroundSync', {
      minimumInterval: 15,
    });

    BackgroundTask.registerTaskAsync.mockRejectedValueOnce(new Error('denied'));
    await expect(bg.registerBackgroundSync()).resolves.toBeUndefined();
  });

  it('registers at the interval chosen in Settings', async () => {
    const { bg, BackgroundTask, TaskManager, interval } = fresh();
    TaskManager.isTaskRegisteredAsync.mockResolvedValue(false);
    await interval.setSyncIntervalMinutes(1440);

    await bg.registerBackgroundSync();
    expect(BackgroundTask.registerTaskAsync).toHaveBeenCalledWith('MedGuardBackgroundSync', {
      minimumInterval: 1440,
    });
  });

  it('unregisters, and never registers, when the interval is Off', async () => {
    const { bg, BackgroundTask, interval } = fresh();
    await interval.setSyncIntervalMinutes(0);

    await bg.registerBackgroundSync();
    expect(BackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith('MedGuardBackgroundSync');
    expect(BackgroundTask.registerTaskAsync).not.toHaveBeenCalled();
  });

  it('leaves an already-scheduled task alone so the countdown is not restarted', async () => {
    const { bg, BackgroundTask } = fresh();
    // Registered at 15 (the mock default) and the stored interval is the default 15.

    await bg.registerBackgroundSync();
    expect(BackgroundTask.unregisterTaskAsync).not.toHaveBeenCalled();
    expect(BackgroundTask.registerTaskAsync).not.toHaveBeenCalled();
  });

  it('reschedules when the registered interval differs from the chosen one', async () => {
    const { bg, BackgroundTask, interval } = fresh();
    await interval.setSyncIntervalMinutes(60);

    await bg.registerBackgroundSync();
    expect(BackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith('MedGuardBackgroundSync');
    expect(BackgroundTask.registerTaskAsync).toHaveBeenCalledWith('MedGuardBackgroundSync', {
      minimumInterval: 60,
    });
  });

  it('does not register where background tasks are restricted', async () => {
    const { bg, BackgroundTask } = fresh();
    BackgroundTask.getStatusAsync.mockResolvedValueOnce(1);

    await bg.registerBackgroundSync();
    expect(BackgroundTask.registerTaskAsync).not.toHaveBeenCalled();
  });

  it('unregisters only when registered, and never throws', async () => {
    const { bg, BackgroundTask, TaskManager } = fresh();

    await bg.unregisterBackgroundSync();
    expect(BackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith('MedGuardBackgroundSync');

    TaskManager.isTaskRegisteredAsync.mockResolvedValueOnce(false);
    await bg.unregisterBackgroundSync();
    expect(BackgroundTask.unregisterTaskAsync).toHaveBeenCalledTimes(1);

    TaskManager.isTaskRegisteredAsync.mockRejectedValueOnce(new Error('boom'));
    await expect(bg.unregisterBackgroundSync()).resolves.toBeUndefined();
  });
});
