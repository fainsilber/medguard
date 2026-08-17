import { SINGLE_PATIENT_ID, computeQuantity } from '@medguard/shared';
import type { Medicine, Schedule } from '@medguard/shared';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import { MedGuardRepository } from '@medguard/store';
import { SqliteStore } from '@medguard/store/sqlite';

/**
 * `headlessTask.ts` is the code that runs when there is no app — a "Taken" or "Snooze" tap that
 * arrived with the process dead, the normal state for a phone locked for hours. Nothing else in
 * this repo exercises it: it's reachable only from `index.ts`'s `registerHeadlessTask`, which
 * nothing in this test suite renders. Before this file, it had zero coverage.
 *
 * Three properties matter here, in order of how load-bearing they are:
 *
 * 1. **The tap instant, not the drain instant, is what gets recorded** — `actualTime` seeds the
 *    rolling-24h PRN cap window, so recording the wrong moment misstates the safety arithmetic,
 *    not just the display.
 * 2. **Safety invariant 7**: a process killed between the write committing and the tap being
 *    acknowledged must cost a repeated read, never a lost dose. Simulated here the same way it
 *    happens on a real device — a second drain that reads the same still-unacked action.
 * 3. **It must never throw.** An unhandled rejection out of a headless task is a native crash on
 *    a locked phone; the module's own doc comment calls this out as strictly worse than the tap
 *    just waiting for the next app launch.
 *
 * `runPendingActionsTask()` hardcodes the database name (`'medguard.db'`) and builds its own
 * repository — deliberately, per its doc comment, since a headless task has no component tree to
 * hang a `RepositoryContext` on. That means test isolation can't come from `renderWithRepository`'s
 * per-call `dbName`; every `it()` below resets the whole module graph instead
 * (`jest.resetModules()`), which gives `testUtils/sqliteTestDouble.ts` a fresh in-memory database
 * map and `mockExpoSecureStore.ts` a fresh identity store, so no state leaks between tests despite
 * the fixed name.
 */

const NOW_ISO = '2026-06-15T05:00:00.000Z'; // 08:00 Jerusalem
const JERUSALEM = 'Asia/Jerusalem';
const DUE_AT = '2026-06-15T09:00:00.000Z'; // 12:00 Jerusalem
const TAP_AT_MS = Date.parse('2026-06-15T09:02:00.000Z');
const OCCURRENCE = `schedule-1:${DUE_AT}`;

const medicine: Medicine = {
  id: 'medicine-1',
  patientId: SINGLE_PATIENT_ID,
  name: 'Ondansetron',
  strength: '4mg',
  form: 'pill',
  asNeeded: false,
  archived: false,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedByDeviceId: 'seed-device',
  syncStatus: 'synced',
};

const schedule: Schedule = {
  id: 'schedule-1',
  medicineId: 'medicine-1',
  patientId: SINGLE_PATIENT_ID,
  frequencyType: 'daily',
  timesOfDay: ['12:00'],
  dosageQuantity: 2,
  startDate: '2026-01-01',
  active: true,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedByDeviceId: 'seed-device',
  syncStatus: 'synced',
};

// `require`, not a dynamic `import()` — see `clock/localClockGuard.test.tsx` for why. Everything
// the SUT touches (the SQLite double, the native alarm mock, caregiver identity) is re-required
// alongside it so this test's own setup and the task under test share the exact same module
// instances, and therefore the exact same in-memory database and identity store.
function freshTask() {
  jest.resetModules();
  // Typed as the real `expo-sqlite` module, not the fake — `moduleNameMapper` swaps the runtime
  // value for `testUtils/sqliteTestDouble.ts`, but TypeScript resolution is unaffected by Jest
  // config, and the fake's `FakeSQLiteDatabase` doesn't structurally satisfy the real
  // `SQLiteDatabase` type `createSqliteSchema`/`ExpoSqliteDriver` declare (only the methods this
  // app actually calls are implemented). Every other file in this app that imports `expo-sqlite`
  // for a Jest test (`readLogs.ts`, `seedAlarmData.ts`) does the same.
  const sqlite = require('expo-sqlite') as typeof import('expo-sqlite');
  const native = require('../../modules/medguard-alarms/src') as typeof import(
    '../../modules/medguard-alarms/src'
  );
  const caregiverName = require('../identity/caregiverName.js') as typeof import(
    '../identity/caregiverName.js'
  );
  const { runPendingActionsTask } = require('./headlessTask.js') as typeof import(
    './headlessTask.js'
  );
  return { sqlite, native, caregiverName, runPendingActionsTask };
}

async function seedHouseholdAndSchedule(sqlite: typeof import('expo-sqlite')) {
  const { ExpoSqliteDriver, createSqliteSchema } = require('../store/expoSqliteDriver.js') as typeof import(
    '../store/expoSqliteDriver.js'
  );
  const db = await sqlite.openDatabaseAsync('medguard.db');
  await createSqliteSchema(db);
  const store = new SqliteStore(new ExpoSqliteDriver(db));
  const repository = new MedGuardRepository(store, {
    clock: fixedClock(NOW_ISO),
    ids: sequentialIds('seed'),
    userId: 'mom',
    deviceId: 'seed-device',
  });

  await repository.saveHouseholdSettings(
    {
      id: 'household',
      timeZone: JERUSALEM,
      escalationAfterMinutes: 15,
      snoozeMinutes: 20,
      updatedAt: NOW_ISO,
      updatedByDeviceId: 'seed-device',
      syncStatus: 'synced',
    },
    'CREATE',
  );
  await repository.saveMedicine(medicine, 'CREATE');
  await repository.saveSchedule(schedule, 'CREATE');
  await repository.adjustInventory({ medicineId: 'medicine-1', delta: 10, reason: 'initial' });

  return repository;
}

describe('runPendingActionsTask — the code that runs when there is no app', () => {
  it('skips the drain entirely when no caregiver has identified themselves on this device', async () => {
    const { native, runPendingActionsTask } = freshTask();
    // No setCaregiverName() call — a fresh install, or a shared device nobody has claimed yet.

    await runPendingActionsTask();

    expect(native.readPendingActions).not.toHaveBeenCalled();
  });

  it('records a captured "Taken" tap at the tap instant, not the drain instant', async () => {
    const { sqlite, native, caregiverName, runPendingActionsTask } = freshTask();
    await caregiverName.setCaregiverName('Mom');
    const repository = await seedHouseholdAndSchedule(sqlite);
    (native.readPendingActions as jest.Mock).mockResolvedValueOnce([
      { id: 'action-1', occurrenceKey: OCCURRENCE, action: 'taken', tappedAtMs: TAP_AT_MS },
    ]);

    await runPendingActionsTask();

    const logs = await repository.logsForPatient(SINGLE_PATIENT_ID);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      status: 'taken',
      scheduleId: 'schedule-1',
      // The tap instant, not whenever the phone happened to next run this task — this is what
      // seeds the rolling-24h PRN cap window.
      actualTime: '2026-06-15T09:02:00.000Z',
      quantityTaken: 2,
    });
    expect(native.ackPendingActions).toHaveBeenCalledWith(['action-1']);
  });

  it('moves stock through the same recordDose call the UI uses, not a second implementation', async () => {
    const { sqlite, native, caregiverName, runPendingActionsTask } = freshTask();
    await caregiverName.setCaregiverName('Mom');
    const repository = await seedHouseholdAndSchedule(sqlite);
    (native.readPendingActions as jest.Mock).mockResolvedValueOnce([
      { id: 'action-1', occurrenceKey: OCCURRENCE, action: 'taken', tappedAtMs: TAP_AT_MS },
    ]);

    await runPendingActionsTask();

    expect(computeQuantity(await repository.adjustmentsForMedicine('medicine-1'))).toBe(8);
  });

  it('costs a repeated read, never a lost or doubled dose, when the process dies between commit and ack', async () => {
    // Safety invariant 7. The scenario this exists to prove safe: the write to `intakeLogs`
    // commits, but the process is killed (or the native ack call fails) before
    // `ackPendingActions` runs — so the *next* drain reads the exact same still-unacked action
    // again. Modeled here by having `readPendingActions` hand back the same entry twice, with
    // `ackPendingActions` never actually removing it (the native mock doesn't track state), which
    // is precisely what "crash before ack landed" looks like from this task's point of view.
    const { sqlite, native, caregiverName, runPendingActionsTask } = freshTask();
    await caregiverName.setCaregiverName('Mom');
    const repository = await seedHouseholdAndSchedule(sqlite);
    const pending = [
      { id: 'action-1', occurrenceKey: OCCURRENCE, action: 'taken' as const, tappedAtMs: TAP_AT_MS },
    ];
    (native.readPendingActions as jest.Mock).mockResolvedValue(pending);

    await runPendingActionsTask();
    await runPendingActionsTask();

    expect(await repository.logsForPatient(SINGLE_PATIENT_ID)).toHaveLength(1);
    expect(computeQuantity(await repository.adjustmentsForMedicine('medicine-1'))).toBe(8);
  });

  it('never throws out of the task — a failure here must not be a native crash on a locked phone', async () => {
    const { sqlite, native, caregiverName, runPendingActionsTask } = freshTask();
    await caregiverName.setCaregiverName('Mom');
    await seedHouseholdAndSchedule(sqlite);
    (native.readPendingActions as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));

    await expect(runPendingActionsTask()).resolves.toBeUndefined();
  });

  it('never throws even when the failure isn’t a real Error', async () => {
    // The native bridge crosses a serialization boundary — what lands in the catch clause is not
    // guaranteed to be an `Error` instance, and the module's own log call branches on that.
    const { sqlite, native, caregiverName, runPendingActionsTask } = freshTask();
    await caregiverName.setCaregiverName('Mom');
    await seedHouseholdAndSchedule(sqlite);
    (native.readPendingActions as jest.Mock).mockRejectedValueOnce('bridge unavailable');

    await expect(runPendingActionsTask()).resolves.toBeUndefined();
  });
});
