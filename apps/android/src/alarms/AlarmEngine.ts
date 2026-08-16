import { MS_PER_DAY, SINGLE_PATIENT_ID, toIso } from '@medguard/shared';
import type { Clock, DoseSnooze, IdGenerator } from '@medguard/shared';
import type { MedGuardRepository } from '@medguard/store';
import { PendingActionApplier, getLastSyncedAt } from '@medguard/store';
import type { Store } from '@medguard/store';
import type {
  ArmedAlarm,
  PendingActionRecord,
  ScheduleDoseAlarmInput,
} from '../../modules/medguard-alarms/src/index.js';
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
  /** Silences audio that is playing now, which `cancelDoseAlarm` does not. */
  stopChime(occurrenceKey?: string): Promise<void>;
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
  /**
   * Whether the server can currently reach this device by push (Sprint A4). `undefined` means
   * "not looked yet", which is deliberately not the same as `false`: registration is async and
   * usually completes moments after launch, and reporting a missing backstop in that window
   * would be a warning that fixes itself before a caregiver finishes reading it.
   */
  isPushRegistered?: () => boolean | undefined;
  log?: AlarmEngineLog;
}

export interface AlarmEngineState {
  health: AlarmHealth;
  staleness: SyncStaleness;
}

/**
 * How far back to look for snoozes. A snooze cannot defer a dose by more than
 * `MAX_SNOOZE_COUNT × snoozeMinutes` (an hour by default), so a day of history is generous by an
 * order of magnitude while still keeping the query bounded as snoozes accumulate over months.
 */
const SNOOZE_LOOKBACK_MS = MS_PER_DAY;

export class AlarmEngine {
  private readonly log: AlarmEngineLog;
  private readonly applier: PendingActionApplier;
  private inFlight: Promise<AlarmEngineState> | null = null;

  constructor(private readonly deps: AlarmEngineDeps) {
    this.log = deps.log ?? noopLog;
    // The conversion of a captured tap into an `IntakeLog`/`DoseSnooze` lives in
    // `@medguard/store` rather than here: the web client's service worker parks the same kind of
    // intent, and one ledger-writing implementation is the whole point of delta AD2. Kotlin's
    // `pending_actions` table is simply this app's `PendingActionSource`.
    this.applier = new PendingActionApplier({
      repository: deps.repository,
      source: deps.native,
      clock: deps.clock,
      ids: deps.ids,
      userId: deps.userId,
      deviceId: deps.deviceId,
      ...(deps.log ? { log: deps.log } : {}),
    });
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
    // Sprint A5. Both read locally, like everything else here: a phone with no signal on Friday
    // afternoon must still arm Shabbat's doses on the Shabbat channel.
    const shabbatConfig = await repository.getShabbatConfig();
    const shabbatWindows = await repository.allShabbatWindows();

    const planned = materializeHorizon({
      schedules,
      medicines,
      logs,
      snoozes,
      timeZone: settings.timeZone,
      nowMs,
      horizonMs: ALARM_HORIZON_MS,
      shabbatWindows,
      shabbatConfig,
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
          // Chosen in `horizon.ts` from the synced Shabbat windows, not fixed here: a dose inside
          // a window rings on the Shabbat channel, which posts no action buttons (delta D5/AD3).
          channelId: alarm.channelId,
          title: alarm.title,
          body: alarm.body,
          chimeDurationSeconds: alarm.chimeDurationSeconds,
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
  /**
   * Stop a chime that is audibly playing, without recording anything.
   *
   * Marking a dose has to silence the phone that is ringing about it — until this existed the two
   * were unconnected, because `cancelDoseAlarm` only unschedules a *future* `AlarmManager` alarm.
   * A caregiver could tap Taken while the room was still full of the alarm and have it keep going
   * for the rest of the chime.
   *
   * Never allowed to fail a dose write: the record is the thing that matters, and a chime that
   * keeps playing stops on its own within a minute anyway.
   */
  async silenceChime(occurrenceKey?: string): Promise<void> {
    try {
      await this.deps.native.stopChime(occurrenceKey);
    } catch (error) {
      this.log.error('failed to stop chime', { error: String(error) });
    }
  }

  async applyPendingActions(): Promise<number> {
    // The notification-action path already stopped the sound natively at the instant of the tap
    // (`NotificationActionReceiver`), which is the only path that works with the app dead. This
    // covers the rest: a tap handed to a live runtime, and a drain that runs at launch.
    await this.silenceChime();
    const applied = await this.applier.applyPendingActions();
    // Reconcile whether or not anything applied: a tap that turned into a dose has changed what
    // should be armed, and one that was skipped as already-logged usually means another device
    // beat us to it — which changes the horizon just the same.
    await this.reconcile();
    return applied;
  }

  /** The Today screen's Snooze button — the same path a notification-action snooze takes. */
  async snooze(key: string): Promise<DoseSnooze | undefined> {
    await this.silenceChime(key);
    const snooze = await this.applier.snooze(key);
    await this.reconcile();
    return snooze;
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

    const pushRegistered = this.deps.isPushRegistered?.();

    return {
      canScheduleExactAlarms,
      hasNotificationPermission,
      isIgnoringBatteryOptimizations,
      hasNotificationPolicyAccess,
      ...(pushRegistered === undefined ? {} : { hasPushRegistration: pushRegistered }),
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
