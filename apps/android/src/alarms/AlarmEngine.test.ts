import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SINGLE_PATIENT_ID, computeQuantity, deriveSnoozeState, fromIso, toIso } from '@medguard/shared';
import type { Medicine, Schedule } from '@medguard/shared';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import { MedGuardRepository, setLastSyncedAt } from '@medguard/store';
import { BetterSqliteDriver, SqliteStore, createSqliteSchema } from '@medguard/store/sqlite';
import type { Store } from '@medguard/store';
import { AlarmEngine } from './AlarmEngine.js';
import type { AlarmNativeSurface } from './AlarmEngine.js';
import type { ArmedAlarm, PendingActionRecord, ScheduleDoseAlarmInput } from '../../modules/medguard-alarms/src/index.js';

/**
 * The alarm engine against a real SQLite store (`better-sqlite3` standing in for `expo-sqlite`,
 * the same substitution `offlineFlow.test.ts` makes and for the same reason) and a fake native
 * surface.
 *
 * Two behaviours here are load-bearing for patient safety, and each has its own group below:
 * a captured tap becomes exactly one dose however many times it is read, and a tap is never lost
 * when the app dies partway through applying it.
 */

const NOW_ISO = '2026-06-15T05:00:00.000Z'; // 08:00 Jerusalem
const JERUSALEM = 'Asia/Jerusalem';
const DUE_AT = '2026-06-15T09:00:00.000Z'; // 12:00 Jerusalem
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
  updatedByDeviceId: 'device-1',
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
  updatedByDeviceId: 'device-1',
  syncStatus: 'synced',
};

/** A controllable stand-in for `modules/medguard-alarms`. */
function fakeNative(overrides: Partial<AlarmNativeSurface> = {}) {
  const armed: ArmedAlarm[] = [];
  let pending: PendingActionRecord[] = [];

  const native: AlarmNativeSurface & {
    armedList: ArmedAlarm[];
    setPending(records: PendingActionRecord[]): void;
    remainingPending(): PendingActionRecord[];
  } = {
    armedList: armed,
    setPending(records) {
      pending = [...records];
    },
    remainingPending: () => pending,

    armDoseAlarms: vi.fn(async (inputs: ScheduleDoseAlarmInput[]) => {
      for (const input of inputs) {
        const existing = armed.findIndex((a) => a.occurrenceKey === input.occurrenceKey);
        const record = { occurrenceKey: input.occurrenceKey, triggerAtMs: input.triggerAtMs };
        if (existing >= 0) armed[existing] = record;
        else armed.push(record);
      }
    }),
    cancelDoseAlarm: vi.fn(async (key: string) => {
      const index = armed.findIndex((a) => a.occurrenceKey === key);
      if (index >= 0) armed.splice(index, 1);
    }),
    listArmedAlarms: vi.fn(async () => [...armed]),
    readPendingActions: vi.fn(async () => [...pending]),
    ackPendingActions: vi.fn(async (ids: string[]) => {
      pending = pending.filter((entry) => !ids.includes(entry.id));
    }),
    canScheduleExactAlarms: vi.fn(async () => true),
    hasNotificationPermission: vi.fn(async () => true),
    isIgnoringBatteryOptimizations: vi.fn(async () => true),
    hasNotificationPolicyAccess: vi.fn(async () => true),
    showStatusNotification: vi.fn(async () => {}),
    clearStatusNotification: vi.fn(async () => {}),
    ...overrides,
  };

  return native;
}

async function setup(native = fakeNative()) {
  const db = new Database(':memory:');
  createSqliteSchema(db);
  const store: Store = new SqliteStore(new BetterSqliteDriver(db));
  const repository = new MedGuardRepository(store, {
    clock: fixedClock(NOW_ISO),
    ids: sequentialIds('generated'),
    userId: 'mom',
    deviceId: 'device-1',
  });

  await repository.saveHouseholdSettings(
    {
      id: 'household',
      timeZone: JERUSALEM,
      escalationAfterMinutes: 15,
      snoozeMinutes: 20,
      updatedAt: NOW_ISO,
      updatedByDeviceId: 'device-1',
      syncStatus: 'synced',
    },
    'CREATE',
  );

  const engine = new AlarmEngine({
    repository,
    store,
    native,
    clock: fixedClock(NOW_ISO),
    ids: sequentialIds('generated'),
    userId: 'mom',
    deviceId: 'device-1',
  });

  return { store, repository, engine, native };
}

async function withSchedule(context: Awaited<ReturnType<typeof setup>>) {
  await context.repository.saveMedicine(medicine, 'CREATE');
  await context.repository.saveSchedule(schedule, 'CREATE');
  return context;
}

function takenAction(overrides: Partial<PendingActionRecord> = {}): PendingActionRecord {
  return {
    id: 'action-1',
    occurrenceKey: OCCURRENCE,
    action: 'taken',
    tappedAtMs: fromIso('2026-06-15T09:02:00.000Z'),
    ...overrides,
  };
}

describe('reconcile', () => {
  it('arms the upcoming doses it finds in local data, with no network involved', async () => {
    const context = await withSchedule(await setup());

    await context.engine.reconcile();

    expect(context.native.armedList.map((a) => a.occurrenceKey)).toEqual([
      OCCURRENCE,
      'schedule-1:2026-06-16T09:00:00.000Z',
    ]);
  });

  it('arms on the standard channel, never the escalation one — escalation is server-only', async () => {
    const context = await withSchedule(await setup());

    await context.engine.reconcile();

    const [inputs] = (context.native.armDoseAlarms as ReturnType<typeof vi.fn>).mock.calls[0] as [
      ScheduleDoseAlarmInput[],
    ];
    expect(inputs[0]).toMatchObject({ channelId: 'dose_standard_v1', escalation: false, chimeDurationSeconds: 45 });
  });

  it('is idempotent — a second reconcile with nothing changed arms nothing new', async () => {
    const context = await withSchedule(await setup());

    await context.engine.reconcile();
    (context.native.armDoseAlarms as ReturnType<typeof vi.fn>).mockClear();
    await context.engine.reconcile();

    expect(context.native.armDoseAlarms).not.toHaveBeenCalled();
  });

  it('cancels an alarm once its dose is logged', async () => {
    const context = await withSchedule(await setup());
    await context.engine.reconcile();

    await context.repository.recordDose({
      id: 'log-1',
      patientId: SINGLE_PATIENT_ID,
      medicineId: 'medicine-1',
      scheduleId: 'schedule-1',
      type: 'scheduled',
      status: 'taken',
      scheduledTime: DUE_AT,
      actualTime: DUE_AT,
      quantityTaken: 2,
      loggedByUserId: 'mom',
      loggedByDeviceId: 'device-1',
      syncStatus: 'pending',
    });
    await context.engine.reconcile();

    expect(context.native.cancelDoseAlarm).toHaveBeenCalledWith(OCCURRENCE);
    expect(context.native.armedList.map((a) => a.occurrenceKey)).toEqual([
      'schedule-1:2026-06-16T09:00:00.000Z',
    ]);
  });

  it('arms nothing and does not crash before a household exists', async () => {
    // A device mid-join has no timezone, and every dose time resolves through it. Arming against
    // a guess would look like a working app while firing hours off.
    const db = new Database(':memory:');
    createSqliteSchema(db);
    const store: Store = new SqliteStore(new BetterSqliteDriver(db));
    const native = fakeNative();
    const engine = new AlarmEngine({
      repository: new MedGuardRepository(store, {
        clock: fixedClock(NOW_ISO),
        ids: sequentialIds('generated'),
        userId: 'mom',
        deviceId: 'device-1',
      }),
      store,
      native,
      clock: fixedClock(NOW_ISO),
      ids: sequentialIds('generated'),
      userId: 'mom',
      deviceId: 'device-1',
    });

    const state = await engine.reconcile();

    expect(native.armedList).toEqual([]);
    expect(state.health.armed).toBe(true);
  });

  it('reports a blocked device and says so in the ongoing notification', async () => {
    const native = fakeNative({ canScheduleExactAlarms: vi.fn(async () => false) });
    const context = await withSchedule(await setup(native));

    const state = await context.engine.reconcile();

    expect(state.health.blockers).toEqual(['exact_alarms_denied']);
    expect(native.showStatusNotification).toHaveBeenCalledWith(
      'MedGuard alarms are off',
      expect.stringContaining('Exact alarms are not permitted'),
    );
  });

  it('clears the ongoing notification once a healthy device is synced', async () => {
    const context = await withSchedule(await setup());
    await setLastSyncedAt(context.store, NOW_ISO);

    await context.engine.reconcile();

    expect(context.native.clearStatusNotification).toHaveBeenCalled();
    expect(context.native.showStatusNotification).not.toHaveBeenCalled();
  });

  it('warns when the local data alarms are armed from has gone stale', async () => {
    const context = await withSchedule(await setup());
    await setLastSyncedAt(context.store, '2026-06-10T05:00:00.000Z');

    const state = await context.engine.reconcile();

    expect(state.staleness.stale).toBe(true);
    expect(context.native.showStatusNotification).toHaveBeenCalledWith(
      'MedGuard has not synced recently',
      expect.stringContaining('will still fire'),
    );
  });

  it('coalesces concurrent runs, so a burst of sync writes does not double-arm', async () => {
    // The store notifies once per pulled record, so one sync round can fire this dozens of times
    // in a tick. Overlapping runs would each diff against the same stale armed list.
    const context = await withSchedule(await setup());

    await Promise.all([
      context.engine.reconcile(),
      context.engine.reconcile(),
      context.engine.reconcile(),
    ]);

    expect(context.native.listArmedAlarms).toHaveBeenCalledTimes(1);
  });
});

describe('applyPendingActions — a lock-screen tap becomes a dose', () => {
  it('records the dose through the shared repository, with the tap timestamp', async () => {
    const context = await withSchedule(await setup());
    context.native.setPending([takenAction()]);

    await context.engine.applyPendingActions();

    const logs = await context.repository.logsForPatient(SINGLE_PATIENT_ID);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      status: 'taken',
      type: 'scheduled',
      scheduleId: 'schedule-1',
      scheduledTime: DUE_AT,
      // The tap instant, not the drain instant: `actualTime` starts the rolling-24h cap window.
      actualTime: '2026-06-15T09:02:00.000Z',
      quantityTaken: 2,
    });
  });

  it('moves stock, because it went through recordDose and not a second implementation', async () => {
    const context = await withSchedule(await setup());
    await context.repository.adjustInventory({ medicineId: 'medicine-1', delta: 10, reason: 'initial' });
    context.native.setPending([takenAction()]);

    await context.engine.applyPendingActions();

    expect(computeQuantity(await context.repository.adjustmentsForMedicine('medicine-1'))).toBe(8);
  });

  it('acknowledges only what it applied', async () => {
    const context = await withSchedule(await setup());
    context.native.setPending([takenAction()]);

    await context.engine.applyPendingActions();

    expect(context.native.ackPendingActions).toHaveBeenCalledWith(['action-1']);
    expect(context.native.remainingPending()).toEqual([]);
  });

  it('logs one dose however many times the same action is read', async () => {
    // The read is non-destructive, so a repeated read is normal rather than exceptional — and
    // `recordDose` is not idempotent: a second call would mint a second inventory adjustment and
    // decrement stock twice for one dose.
    const context = await withSchedule(await setup());
    await context.repository.adjustInventory({ medicineId: 'medicine-1', delta: 10, reason: 'initial' });

    context.native.setPending([takenAction()]);
    await context.engine.applyPendingActions();
    context.native.setPending([takenAction()]);
    await context.engine.applyPendingActions();

    expect(await context.repository.logsForPatient(SINGLE_PATIENT_ID)).toHaveLength(1);
    expect(computeQuantity(await context.repository.adjustmentsForMedicine('medicine-1'))).toBe(8);
  });

  it('does not double-log a dose the UI already recorded', async () => {
    const context = await withSchedule(await setup());
    await context.repository.recordDose({
      id: 'log-from-ui',
      patientId: SINGLE_PATIENT_ID,
      medicineId: 'medicine-1',
      scheduleId: 'schedule-1',
      type: 'scheduled',
      status: 'taken',
      scheduledTime: DUE_AT,
      actualTime: DUE_AT,
      quantityTaken: 2,
      loggedByUserId: 'mom',
      loggedByDeviceId: 'device-1',
      syncStatus: 'pending',
    });

    context.native.setPending([takenAction()]);
    await context.engine.applyPendingActions();

    expect(await context.repository.logsForPatient(SINGLE_PATIENT_ID)).toHaveLength(1);
  });

  it('keeps an action un-acked when applying it fails, so the tap survives to be retried', async () => {
    // Safety invariant 7. This is the exact scenario the destructive drain used to lose: the
    // process dies (or the write fails) after the read but before the dose is committed.
    const context = await withSchedule(await setup());
    vi.spyOn(context.repository, 'recordDose').mockRejectedValueOnce(new Error('disk full'));
    context.native.setPending([takenAction()]);

    const applied = await context.engine.applyPendingActions();

    expect(applied).toBe(0);
    expect(context.native.ackPendingActions).not.toHaveBeenCalled();
    expect(context.native.remainingPending()).toHaveLength(1);
    expect(await context.repository.logsForPatient(SINGLE_PATIENT_ID)).toEqual([]);
  });

  it('applies the rest of a batch when one action fails', async () => {
    const context = await withSchedule(await setup());
    context.native.setPending([
      takenAction({ id: 'broken', occurrenceKey: 'not-a-valid-key' }),
      takenAction({ id: 'good' }),
    ]);

    await context.engine.applyPendingActions();

    expect(await context.repository.logsForPatient(SINGLE_PATIENT_ID)).toHaveLength(1);
  });

  it('drops an action whose schedule no longer exists rather than inventing a dose', async () => {
    const context = await setup();
    await context.repository.saveMedicine(medicine, 'CREATE');
    context.native.setPending([takenAction()]);

    await context.engine.applyPendingActions();

    expect(await context.repository.logsForPatient(SINGLE_PATIENT_ID)).toEqual([]);
  });

  it('applies taps oldest-first, so two taps resolve in the order they were made', async () => {
    const context = await withSchedule(await setup());
    context.native.setPending([
      takenAction({ id: 'second', action: 'taken', tappedAtMs: fromIso('2026-06-15T09:05:00.000Z') }),
      takenAction({ id: 'first', action: 'snooze', tappedAtMs: fromIso('2026-06-15T09:01:00.000Z') }),
    ]);

    await context.engine.applyPendingActions();

    // Snooze first, then taken — so the dose is recorded and the snooze is merely history.
    const snoozes = await context.repository.snoozesForOccurrence(OCCURRENCE);
    expect(snoozes).toHaveLength(1);
    expect(await context.repository.logsForPatient(SINGLE_PATIENT_ID)).toHaveLength(1);
  });

  it('does nothing at all when there is nothing captured', async () => {
    const context = await withSchedule(await setup());

    expect(await context.engine.applyPendingActions()).toBe(0);
    expect(context.native.ackPendingActions).not.toHaveBeenCalled();
  });

  it('re-arms after applying, so a snoozed dose gets its new alarm', async () => {
    const context = await withSchedule(await setup());
    await context.engine.reconcile();

    context.native.setPending([
      takenAction({ id: 'snooze-tap', action: 'snooze', tappedAtMs: fromIso('2026-06-15T09:01:00.000Z') }),
    ]);
    await context.engine.applyPendingActions();

    const armed = context.native.armedList.find((a) => a.occurrenceKey === OCCURRENCE);
    expect(toIso(armed!.triggerAtMs)).toBe('2026-06-15T09:21:00.000Z');
  });
});

describe('snooze', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('records a snooze at the household’s configured length', async () => {
    const context = await withSchedule(await setup());

    const snooze = await context.engine.snooze(OCCURRENCE);

    expect(snooze).toMatchObject({ occurrenceId: OCCURRENCE, minutes: 20, count: 1 });
  });

  it('grants exactly three, then refuses', async () => {
    const context = await withSchedule(await setup());

    expect(await context.engine.snooze(OCCURRENCE)).toBeDefined();
    expect(await context.engine.snooze(OCCURRENCE)).toBeDefined();
    expect(await context.engine.snooze(OCCURRENCE)).toBeDefined();
    expect(await context.engine.snooze(OCCURRENCE)).toBeUndefined();

    const stored = await context.repository.snoozesForOccurrence(OCCURRENCE);
    expect(stored).toHaveLength(3);
    expect(deriveSnoozeState(stored, OCCURRENCE).canSnooze).toBe(false);
  });

  it('leaves the dose overdue and still ringing once the bound is reached', async () => {
    // Fail closed: a caregiver who has deferred three times does not get silence, they get an
    // alarm that keeps going until the dose is actually dealt with.
    const context = await withSchedule(await setup());
    for (let i = 0; i < 4; i += 1) {
      await context.engine.snooze(OCCURRENCE);
    }

    const armed = context.native.armedList.find((a) => a.occurrenceKey === OCCURRENCE);
    // Three 20-minute snoozes from the fixed clock (08:00 Jerusalem = 05:00Z).
    expect(toIso(armed!.triggerAtMs)).toBe('2026-06-15T05:20:00.000Z');
  });

  it('numbers snoozes 1-based and consecutively', async () => {
    const context = await withSchedule(await setup());
    await context.engine.snooze(OCCURRENCE);
    await context.engine.snooze(OCCURRENCE);

    const counts = (await context.repository.snoozesForOccurrence(OCCURRENCE))
      .map((snooze) => snooze.count)
      .sort();
    expect(counts).toEqual([1, 2]);
  });

  it('queues each snooze for sync, so the server can stop an escalation', async () => {
    const context = await withSchedule(await setup());
    await context.engine.snooze(OCCURRENCE);

    const outbox = await context.repository.pendingSync();
    expect(outbox.some((entry) => entry.table === 'doseSnoozes')).toBe(true);
  });
});
