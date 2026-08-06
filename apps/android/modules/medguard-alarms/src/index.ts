import { requireNativeModule } from 'expo-modules-core';

import type {
  MedGuardAlarmsModuleEvents,
  PendingActionEvent,
  ScheduleDoseAlarmInput,
} from './MedGuardAlarms.types';

export type { MedGuardChannelId, PendingActionEvent, ScheduleDoseAlarmInput } from './MedGuardAlarms.types';

interface MedGuardAlarmsNativeModule {
  scheduleDoseAlarm(input: ScheduleDoseAlarmInput): Promise<void>;
  cancelDoseAlarm(occurrenceKey: string): Promise<void>;
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
   * notification action handler to a local `pending_actions` table, not yet converted into a
   * domain `IntakeLog`. Draining and applying them through `recordDose()` is JS's job — Kotlin
   * never writes an intake log itself.
   */
  drainPendingActions(): Promise<PendingActionEvent[]>;
}

const nativeModule = requireNativeModule<MedGuardAlarmsNativeModule>('MedGuardAlarms');

export const scheduleDoseAlarm = (input: ScheduleDoseAlarmInput): Promise<void> =>
  nativeModule.scheduleDoseAlarm(input);

export const cancelDoseAlarm = (occurrenceKey: string): Promise<void> =>
  nativeModule.cancelDoseAlarm(occurrenceKey);

export const playTestChime = (chimeDurationSeconds: number): Promise<void> =>
  nativeModule.playTestChime(chimeDurationSeconds);

export const canScheduleExactAlarms = (): Promise<boolean> => nativeModule.canScheduleExactAlarms();

export const requestScheduleExactAlarm = (): Promise<void> => nativeModule.requestScheduleExactAlarm();

export const hasNotificationPermission = (): Promise<boolean> => nativeModule.hasNotificationPermission();

export const requestNotificationPermission = (): Promise<boolean> =>
  nativeModule.requestNotificationPermission().then((result) => result.granted);

export const canUseFullScreenIntent = (): Promise<boolean> => nativeModule.canUseFullScreenIntent();

export const isIgnoringBatteryOptimizations = (): Promise<boolean> =>
  nativeModule.isIgnoringBatteryOptimizations();

export const requestIgnoreBatteryOptimizations = (): Promise<void> =>
  nativeModule.requestIgnoreBatteryOptimizations();

export const hasNotificationPolicyAccess = (): Promise<boolean> => nativeModule.hasNotificationPolicyAccess();

export const requestNotificationPolicyAccess = (): Promise<void> =>
  nativeModule.requestNotificationPolicyAccess();

export const drainPendingActions = (): Promise<PendingActionEvent[]> => nativeModule.drainPendingActions();

export type { MedGuardAlarmsModuleEvents };
