import {
  MS_PER_DAY,
  SINGLE_PATIENT_ID,
  buildDoseSnooze,
  deriveSnoozeState,
  expandSchedules,
  findLogForOccurrence,
  fromIso,
  occurrenceKey,
  parseOccurrenceKey,
  toIso,
} from '@medguard/shared';
import type { Clock, DoseSnooze, IdGenerator, IntakeLog, Occurrence } from '@medguard/shared';
import type { MedGuardRepository } from '@medguard/store';
import { getLastSyncedAt } from '@medguard/store';
import type { Store } from '@medguard/store';
import type { ArmedAlarm, PendingActionRecord, ScheduleDoseAlarmInput } from '../../modules/medguard-alarms/src/index.js';
import { diffAlarms } from './alarmReconciler.js';
import { deriveAlarmHealth, deriveSyncStaleness, describeAlarmStatus } from './alarmHealth.js';
import type { AlarmHealth, AlarmPermissions, SyncStaleness } from './alarmHealth.js';
import { ALARM_HORIZON_MS, materializeHorizon } from './horizon.js';

/**
 * The alarm engine: the one place that talks to both the repository and Android.
 *
 * Framework-free, in the style of `SyncEngine` — a plain class with async methods and every
 * dependency injected, including the native surface — so the behaviours that matter (a tap
 * becoming a dose exactly once; a dose never lost when the app dies mid-apply) are testable
 * against a fake rather than only on a phone.
 *
 * All the *decisions* live in the pure modules beside this one (`horizon.ts`,
 * `alarmReconciler.ts`, `alarmHealth.ts`). This file is orchestration: read, decide, apply.
 */

/** The slice of `modules/medguard-alarms` the engine uses, injected so tests can fake it. */
export interface AlarmNativeSurface {
  armDoseAlarms(inputs: ScheduleDoseAlarmInput[]): Promise<void>;
  cancelDoseAlarm(occurrenceKey: string): Promise<void>;
  listArmedAlarms(): Promise<ArmedAlarm[]>;
  readPendingActions(): Promise<PendingActionRecord[]>;
  ackPendingActions(ids: string[]): Promise<void>;
  canScheduleExactAlarms(): Promise<boolean>;
  hasNotificationPermission(): Promise<boolean>;
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  hasNotificationPolicyAccess(): Promise<boolean>;
  showStatusNotification(title: string, body: string): Promise<void>;
  clearStatusNotification(): Promise<void>;
}

export interface AlarmEngineLog {
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const noopLog: AlarmEngineLog = { debug: () => {}, error: () => {} };

export interface AlarmEngineDeps {
  repository: MedGuardRepository;
  store: Store;
  native: AlarmNativeSurface;
  clock: Clock;
  ids: IdGenerator;
  userId: string;
  deviceId: string;
  log?: AlarmEngineLog;
}

export interface AlarmEngineState {
  health: AlarmHealth;
  staleness: SyncStaleness;
}

/**
 * PRD default. Not on `HouseholdSettings` — the PRD puts `chimeDurationSeconds` on `ShabbatConfig`
 * (per-patient, and A5's concern), and inventing a second household-level field for the weekday
 * case ahead of any UI to change it would be schema churn for nothing. One constant here is the
 * honest representation of "we have not made this configurable yet".
 */
const CHIME_DURATION_SECONDS = 45;

/**
 * How far back to look for snoozes. A snooze cannot defer a dose by more than
 * `MAX_SNOOZE_COUNT × snoozeMinutes` (an hour by default), so a day of history is generous by an
 * order of magnitude while still keeping the query bounded as snoozes accumulate over months.
 */
const SNOOZE_LOOKBACK_MS = MS_PER_DAY;

export class AlarmEngine {
  private readonly log: AlarmEngineLog;
  private inFlight: Promise<AlarmEngineState> | null = null;
  private applyInFlight: Promise<number> | null = null;

  constructor(private readonly deps: AlarmEngineDeps) {
    this.log = deps.log ?? noopLog;
  }

  /**
   * Brings Android's armed alarms in line with what the local data says should be armed, and
   * reports whether this device can fire them at all.
   *
   * Coalesced the same way `SyncEngine.runOnce()` is, and for the same underlying reason: this is
   * triggered by store notifications that arrive one *per pulled record*, so a single sync round
   * can fire it dozens of times in a tick. Overlapping runs would both read, both diff against the
   * same stale armed list, and both try to arm the same alarms.
   */
  reconcile(): Promise<AlarmEngineState> {
    this.inFlight ??= this.reconcileExclusive().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async reconcileExclusive(): Promise<AlarmEngineState> {
    const { repository, store, native, clock } = this.deps;

    const nowMs = clock.nowMs();
    const settings = await repository.getHouseholdSettings();
    const staleness = deriveSyncStaleness(await getLastSyncedAt(store), nowMs);

    // No household settings means no timezone, and every dose time in the system resolves through
    // it. Arming against a guess would be worse than arming nothing: a wrong-by-hours alarm reads
    // as a working app.
    if (!settings) {
      const health = deriveAlarmHealth(await this.readPermissions(), 0);
      await this.publishStatus(health, staleness);
      return { health, staleness };
    }

    // Sequential, not Promise.all: each of these opens its own `store.transaction()`, and the
    // `Store` port makes no promise that overlapping transactions are safe — `expo-sqlite`'s
    // single connection needed an explicit queue added at the driver level for exactly this
    // reason (`apps/android/README.md`, "Sync and household join"). Reading one at a time costs
    // nothing here — these are independent reads, not a batch racing a deadline — and it keeps
    // the engine correct against any `Store` implementation, queued or not.
    const schedules = await repository.allSchedules();
    const medicines = await repository.allMedicines();
    const logs = await repository.logsForPatient(SINGLE_PATIENT_ID);
    const snoozes = await repository.recentSnoozes(toIso(nowMs - SNOOZE_LOOKBACK_MS));

    const planned = materializeHorizon({
      schedules,
      medicines,
      logs,
      snoozes,
      timeZone: settings.timeZone,
      nowMs,
      horizonMs: ALARM_HORIZON_MS,
    });

    const armed = await native.listArmedAlarms();
    const { toArm, toCancel } = diffAlarms(armed, planned);

    for (const key of toCancel) {
      await native.cancelDoseAlarm(key);
    }
    if (toArm.length > 0) {
      await native.armDoseAlarms(
        toArm.map((alarm) => ({
          occurrenceKey: alarm.occurrenceKey,
          triggerAtMs: alarm.triggerAtMs,
          channelId: 'dose_standard_v1' as const,
          title: alarm.title,
          body: alarm.body,
          chimeDurationSeconds: CHIME_DURATION_SECONDS,
          // Escalation is server-only (docs/android-client-plan.md, "Local versus server
          // alarms"): a device cannot know whether *another* caregiver acknowledged, which is
          // exactly what an escalation is for.
          escalation: false,
        })),
      );
    }

    this.log.debug('alarms reconciled', {
      planned: planned.length,
      armedBefore: armed.length,
      armedNow: toArm.length,
      cancelled: toCancel.length,
    });

    const health = deriveAlarmHealth(await this.readPermissions(), planned.length);
    await this.publishStatus(health, staleness);
    return { health, staleness };
  }

  /**
   * Converts taps captured natively — possibly with the app process dead at the time — into real
   * domain records, through the same `recordDose()` the UI calls (AD2).
   *
   * Two properties carry the weight here:
   *
   * 1. **Each action is acknowledged only after its record has committed.** A process killed
   *    mid-apply therefore repeats a read rather than dropping a caregiver's tap (invariant 7).
   * 2. **A dose already logged is skipped, not re-recorded.** `recordDose` is not idempotent — a
   *    second call for the same occurrence would mint a second inventory adjustment and
   *    double-decrement stock — and property 1 makes repeated reads normal, not exceptional.
   */
  applyPendingActions(): Promise<number> {
    // Coalesced for the same reason `reconcile()` is: `AlarmProvider` calls this from several
    // independent triggers (mount, `AppState` -> 'active', the native `onPendingAction` event)
    // that can land within milliseconds of each other on a real device — a cold launch triggered
    // by tapping a notification fires the launch-time call and the resulting foreground/event
    // triggers together. Uncoalesced, both calls read the same not-yet-acked entries and process
    // them twice; for 'taken' that race is closed by `applyOne`'s existing-log check, but only if
    // the first call's write commits before the second call's read — not guaranteed under
    // concurrency, so this closes the race at the source instead of relying on that ordering.
    this.applyInFlight ??= this.applyPendingActionsExclusive().finally(() => {
      this.applyInFlight = null;
    });
    return this.applyInFlight;
  }

  private async applyPendingActionsExclusive(): Promise<number> {
    const { native } = this.deps;

    const pending = await native.readPendingActions();
    if (pending.length === 0) {
      return 0;
    }

    // Oldest tap first, so two taps on the same dose resolve in the order the caregiver made them.
    const ordered = [...pending].sort((a, b) => a.tappedAtMs - b.tappedAtMs);

    const applied: string[] = [];
    for (const action of ordered) {
      try {
        await this.applyOne(action);
        applied.push(action.id);
      } catch (error) {
        // Leave it un-acked and keep going: one unparseable or failing action must not block the
        // rest, and a genuinely broken one is retried on the next drain rather than lost.
        this.log.error('could not apply a captured notification action', {
          id: action.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (applied.length > 0) {
      await native.ackPendingActions(applied);
    }

    this.log.debug('pending actions applied', { read: pending.length, applied: applied.length });
    await this.reconcile();
    return applied.length;
  }

  /** The Today screen's Snooze button — the same path a notification-action snooze takes. */
  async snooze(key: string): Promise<DoseSnooze | undefined> {
    const snooze = await this.recordSnoozeFor(key, this.deps.clock.nowMs());
    await this.reconcile();
    return snooze;
  }

  // -------------------------------------------------------------------------

  private async applyOne(action: PendingActionRecord): Promise<void> {
    if (action.action === 'snooze') {
      await this.recordSnoozeFor(action.occurrenceKey, action.tappedAtMs);
      return;
    }

    const { repository, ids, userId, deviceId } = this.deps;
    const occurrence = await this.resolveOccurrence(action.occurrenceKey);
    if (!occurrence) {
      // A schedule revised or stopped between the tap and the drain. Nothing to log against, and
      // inventing an occurrence would be worse than dropping the tap.
      this.log.error('no occurrence for a captured action', { occurrenceKey: action.occurrenceKey });
      return;
    }

    const logs = await repository.logsForPatient(SINGLE_PATIENT_ID);
    if (findLogForOccurrence(logs, occurrence) !== undefined) {
      // Already recorded — by the UI, by another device's sync, or by a previous drain that
      // committed and then died before acknowledging. Skipping is what makes the retry safe.
      this.log.debug('skipping an already-logged occurrence', { occurrenceKey: action.occurrenceKey });
      return;
    }

    const log: IntakeLog = {
      id: ids.next(),
      patientId: occurrence.patientId,
      medicineId: occurrence.medicineId,
      scheduleId: occurrence.scheduleId,
      type: 'scheduled',
      status: 'taken',
      scheduledTime: occurrence.dueAt,
      // The tap instant, never the drain instant: `actualTime` starts the rolling-24h cap window,
      // so recording the wrong moment misstates both the history and the safety arithmetic.
      actualTime: toIso(action.tappedAtMs),
      quantityTaken: occurrence.dosageQuantity,
      loggedByUserId: userId,
      loggedByDeviceId: deviceId,
      syncStatus: 'pending',
    };

    await repository.recordDose(log);
  }

  private async recordSnoozeFor(key: string, atMs: number): Promise<DoseSnooze | undefined> {
    // Same well-formedness check the server's `occurrenceKeySchema` enforces on `doseSnoozes`
    // pushes — deliberately just "parses as scheduleId:dueAt", not "the schedule still exists"
    // (unlike `resolveOccurrence`), since a snooze recorded a moment before a schedule was edited
    // is still a legitimate historical fact. Without this, a garbage key — the A0 Diagnostics
    // "Arm alarm in 15s" test button arms with a bare device-generated UUID, never a real
    // occurrenceKey, precisely because it isn't meant to be actioned — reaches `recordSnooze()`
    // unchecked, and the resulting record fails the server's schema forever: `pushSchema` only
    // returns a per-record `rejected` entry for a *table-schema* failure, but a malformed
    // `occurrenceId` here still passes the outer request shape, so it lands in the outbox and
    // then the whole batch keeps re-failing in `SyncEngine.drainOutbox()` on every retry. The
    // 'taken' path in `applyOne` already refuses the same class of bad key via `resolveOccurrence`;
    // this mirrors that for 'snooze', which had no equivalent guard.
    if (parseOccurrenceKey(key) === undefined) {
      this.log.error('refusing to snooze — not a real occurrence key', { occurrenceKey: key });
      return undefined;
    }

    const { repository, clock, ids, userId, deviceId } = this.deps;

    const settings = await repository.getHouseholdSettings();
    if (!settings) {
      return undefined;
    }

    const existing = await repository.snoozesForOccurrence(key);
    const state = deriveSnoozeState(existing, key);
    if (!state.canSnooze) {
      // The bound is reached. Deliberately silent rather than an error: the occurrence simply
      // stays overdue and keeps ringing, which is the fail-closed direction for a missed dose.
      this.log.debug('snooze refused — bound reached', { occurrenceKey: key, count: state.count });
      return undefined;
    }

    return repository.recordSnooze(
      buildDoseSnooze(key, settings.snoozeMinutes, state.count, { clock, ids, userId, deviceId }, atMs),
    );
  }

  /**
   * Rebuilds the `Occurrence` behind an `occurrenceKey`, by re-expanding just its schedule across
   * the day the dose was due.
   *
   * The key carries only the schedule id and the instant, but `recordDose` needs the patient,
   * medicine and dosage too — and re-deriving them through `expandSchedules` rather than reading
   * them off the schedule row directly means a dose recorded from a notification goes through the
   * exact same DST-aware expansion as one recorded in the UI.
   */
  private async resolveOccurrence(key: string): Promise<Occurrence | undefined> {
    const parsed = parseOccurrenceKey(key);
    if (!parsed) {
      return undefined;
    }

    const { repository } = this.deps;
    const settings = await repository.getHouseholdSettings();
    if (!settings) {
      return undefined;
    }

    const schedules = await repository.allSchedules();
    const schedule = schedules.find((candidate) => candidate.id === parsed.scheduleId);
    if (!schedule) {
      return undefined;
    }

    const dueMs = fromIso(parsed.dueAt);
    const occurrences = expandSchedules(
      [schedule],
      { fromMs: dueMs - MS_PER_DAY, toMs: dueMs + MS_PER_DAY },
      settings.timeZone,
    );

    return occurrences.find((occurrence) => occurrenceKey(occurrence) === key);
  }

  private async readPermissions(): Promise<AlarmPermissions> {
    const { native } = this.deps;
    const [
      canScheduleExactAlarms,
      hasNotificationPermission,
      isIgnoringBatteryOptimizations,
      hasNotificationPolicyAccess,
    ] = await Promise.all([
      native.canScheduleExactAlarms(),
      native.hasNotificationPermission(),
      native.isIgnoringBatteryOptimizations(),
      native.hasNotificationPolicyAccess(),
    ]);

    return {
      canScheduleExactAlarms,
      hasNotificationPermission,
      isIgnoringBatteryOptimizations,
      hasNotificationPolicyAccess,
    };
  }

  private async publishStatus(health: AlarmHealth, staleness: SyncStaleness): Promise<void> {
    const status = describeAlarmStatus(health, staleness);
    if (status) {
      await this.deps.native.showStatusNotification(status.title, status.body);
    } else {
      await this.deps.native.clearStatusNotification();
    }
  }
}
