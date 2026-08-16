import { requireNativeModule } from 'expo-modules-core';
import type { EventSubscription } from 'expo-modules-core';

import type {
  ArmedAlarm,
  MedGuardAlarmsModuleEvents,
  PendingActionEvent,
  PendingActionRecord,
  PushTokenEvent,
  ScheduleDoseAlarmInput,
} from './MedGuardAlarms.types';

export type {
  ArmedAlarm,
  MedGuardChannelId,
  PendingActionEvent,
  PendingActionRecord,
  PushTokenEvent,
  ScheduleDoseAlarmInput,
} from './MedGuardAlarms.types';

interface MedGuardAlarmsNativeModule {
  scheduleDoseAlarm(input: ScheduleDoseAlarmInput): Promise<void>;
  /** The reconcile pass's batch form — one bridge call for a whole horizon, not one per alarm. */
  armDoseAlarms(inputs: ScheduleDoseAlarmInput[]): Promise<void>;
  cancelDoseAlarm(occurrenceKey: string): Promise<void>;
  /** For leaving a household or clearing local data, when there is nothing left to reconcile against. */
  cancelAllDoseAlarms(): Promise<void>;
  /**
   * Silence a chime that is sounding *right now*.
   *
   * `cancelDoseAlarm` unschedules a future alarm and does nothing to audio already playing, which
   * is why marking a dose taken in the app used to leave the phone ringing. Pass an occurrence key
   * to drop just that dose (the sound stops only if it was the last one sounding), or nothing to
   * stop the sound outright. Every notification survives either way, non-ongoing and dismissible.
   *
   * Safe to call when nothing is playing, so callers never have to ask first.
   */
  stopChime(occurrenceKey: string | null): Promise<void>;
  /**
   * What Android currently holds armed. The reconcile pass diffs against this rather than against
   * a JS-side list, because `BootReceiver` re-arms and expires alarms without JS ever seeing it.
   */
  listArmedAlarms(): Promise<ArmedAlarm[]>;
  /** The ongoing, silent `sync_status_v1` notification carrying the two degradation states. */
  showStatusNotification(title: string, body: string): Promise<void>;
  clearStatusNotification(): Promise<void>;
  addListener(
    event: 'onPendingAction',
    listener: (payload: PendingActionEvent) => void,
  ): EventSubscription;
  addListener(event: 'onPushToken', listener: (payload: PushTokenEvent) => void): EventSubscription;
  /** Fires immediately: the standalone chime demo for the A0 exit gate and manual QA item 1. */
  playTestChime(chimeDurationSeconds: number): Promise<void>;
  canScheduleExactAlarms(): Promise<boolean>;
  /** Opens `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` (Android 12 only; 13+ grants at install). */
  requestScheduleExactAlarm(): Promise<void>;
  /** Always `true` below Android 13 — the permission didn't exist yet. */
  hasNotificationPermission(): Promise<boolean>;
  /**
   * The real runtime prompt (Android 13+ only); a no-op resolve(true) on older OS versions.
   * Resolves the shape `expo-modules-core`'s `Permissions` interface always returns
   * (`{granted, status, canAskAgain, expires}`), not a bare boolean.
   */
  requestNotificationPermission(): Promise<{ granted: boolean }>;
  canUseFullScreenIntent(): Promise<boolean>;
  isIgnoringBatteryOptimizations(): Promise<boolean>;
  requestIgnoreBatteryOptimizations(): Promise<void>;
  hasNotificationPolicyAccess(): Promise<boolean>;
  requestNotificationPolicyAccess(): Promise<void>;
  /**
   * Intent captured natively while the JS process may be dead (AD2): rows written by the
   * notification action handler, not yet converted into a domain `IntakeLog`. Applying them
   * through `recordDose()` is JS's job — Kotlin never writes an intake log itself.
   *
   * Non-destructive. `ackPendingActions` is what removes them, and JS calls it only once the
   * resulting records have committed, so a process killed mid-apply repeats a read rather than
   * dropping a caregiver's tap (safety invariant 7).
   */
  readPendingActions(): Promise<PendingActionRecord[]>;
  ackPendingActions(ids: string[]): Promise<void>;
  /**
   * Milliseconds since boot, including time spent in deep sleep (`SystemClock.elapsedRealtime()`)
   * — unlike `performance.now()`, which halts across real device sleep on Android. The monotonic
   * reference `src/clock/localClockGuard.ts` needs so a normal phone-locked period doesn't look
   * identical to a caregiver winding the wall clock forward.
   */
  elapsedRealtimeMs(): Promise<number>;
  /**
   * The FCM registration token, or `null` when this build has no Firebase project configured or
   * Firebase has not issued one yet. Null is a supported state — local alarms are primary, and a
   * device with no token simply has no server backstop, which `alarmHealth` says out loud.
   */
  getPushToken(): Promise<string | null>;
}

const nativeModule = requireNativeModule<MedGuardAlarmsNativeModule>('MedGuardAlarms');

export const scheduleDoseAlarm = (input: ScheduleDoseAlarmInput): Promise<void> =>
  nativeModule.scheduleDoseAlarm(input);

export const armDoseAlarms = (inputs: ScheduleDoseAlarmInput[]): Promise<void> =>
  nativeModule.armDoseAlarms(inputs);

export const cancelDoseAlarm = (occurrenceKey: string): Promise<void> =>
  nativeModule.cancelDoseAlarm(occurrenceKey);

export const cancelAllDoseAlarms = (): Promise<void> => nativeModule.cancelAllDoseAlarms();

// Always one argument, explicitly `null` for "stop everything", rather than letting `undefined`
// reach the bridge — the native function's arity is then never in question.
export const stopChime = (occurrenceKey?: string): Promise<void> =>
  nativeModule.stopChime(occurrenceKey ?? null);

export const listArmedAlarms = (): Promise<ArmedAlarm[]> => nativeModule.listArmedAlarms();

export const showStatusNotification = (title: string, body: string): Promise<void> =>
  nativeModule.showStatusNotification(title, body);

export const clearStatusNotification = (): Promise<void> => nativeModule.clearStatusNotification();

/**
 * Fires when a Taken/Snooze action is tapped *while a JS runtime is alive* — the common case for
 * a merely-locked phone. A dead process captures the tap durably instead and it is applied at the
 * next launch, so this is a latency optimisation, never the only path.
 */
export const addPendingActionListener = (
  listener: (event: PendingActionEvent) => void,
): EventSubscription => nativeModule.addListener('onPendingAction', listener);

export const playTestChime = (chimeDurationSeconds: number): Promise<void> =>
  nativeModule.playTestChime(chimeDurationSeconds);

export const canScheduleExactAlarms = (): Promise<boolean> => nativeModule.canScheduleExactAlarms();

export const requestScheduleExactAlarm = (): Promise<void> =>
  nativeModule.requestScheduleExactAlarm();

export const hasNotificationPermission = (): Promise<boolean> =>
  nativeModule.hasNotificationPermission();

export const requestNotificationPermission = (): Promise<boolean> =>
  nativeModule.requestNotificationPermission().then((result) => result.granted);

export const canUseFullScreenIntent = (): Promise<boolean> => nativeModule.canUseFullScreenIntent();

export const isIgnoringBatteryOptimizations = (): Promise<boolean> =>
  nativeModule.isIgnoringBatteryOptimizations();

export const requestIgnoreBatteryOptimizations = (): Promise<void> =>
  nativeModule.requestIgnoreBatteryOptimizations();

export const hasNotificationPolicyAccess = (): Promise<boolean> =>
  nativeModule.hasNotificationPolicyAccess();

export const requestNotificationPolicyAccess = (): Promise<void> =>
  nativeModule.requestNotificationPolicyAccess();

export const readPendingActions = (): Promise<PendingActionRecord[]> =>
  nativeModule.readPendingActions();

export const ackPendingActions = (ids: string[]): Promise<void> =>
  nativeModule.ackPendingActions(ids);

export const elapsedRealtimeMs = (): Promise<number> => nativeModule.elapsedRealtimeMs();

export const getPushToken = (): Promise<string | null> => nativeModule.getPushToken();

/**
 * Fires when Firebase rotates this device's registration token — after a reinstall, a restore, or
 * on its own schedule. Best-effort: the token is also written to native storage, because
 * `onNewToken` frequently fires with no JS runtime alive at all.
 */
export const addPushTokenListener = (
  listener: (event: PushTokenEvent) => void,
): EventSubscription => nativeModule.addListener('onPushToken', listener);

export type { MedGuardAlarmsModuleEvents };
