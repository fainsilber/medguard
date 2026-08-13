/**
 * Versioned notification channel ids (docs/android-client-plan.md, "Channels"). A channel's
 * sound and importance are immutable after creation, so retuning the chime the way the web
 * Shabbat burst was retuned four times requires a new id here, not an edit to an existing one.
 */
export type MedGuardChannelId =
  | 'dose_standard_v1'
  | 'dose_escalation_v1'
  | 'shabbat_v1'
  | 'low_stock_v1'
  | 'sync_status_v1';

export interface ScheduleDoseAlarmInput {
  /** `occurrenceKey` from `packages/shared/src/schedule.ts` — the Android notification tag. */
  occurrenceKey: string;
  /** Epoch milliseconds. Passed straight to `AlarmManager`; no ambient time read on the JS side. */
  triggerAtMs: number;
  channelId: MedGuardChannelId;
  title: string;
  body: string;
  /** How long the alarm-stream chime plays before it auto-stops. PRD default: 45. */
  chimeDurationSeconds: number;
  /** Whether to attempt DND bypass / full-screen escalation for this alarm (escalation only). */
  escalation: boolean;
}

export interface PendingActionEvent {
  occurrenceKey: string;
  action: 'taken' | 'snooze';
  /** Epoch milliseconds at the instant the user tapped — not the instant JS applies it (AD2). */
  tappedAtMs: number;
}

/**
 * A captured tap as it sits in native storage, with the id the acknowledgement is keyed by.
 *
 * The id exists because reading and acknowledging are separate calls: JS acks only after the
 * resulting `IntakeLog`/`DoseSnooze` has actually committed, so an app killed mid-apply repeats
 * a read instead of losing a dose (safety invariant 7).
 */
export interface PendingActionRecord extends PendingActionEvent {
  id: string;
}

/** One armed alarm as Android currently holds it — the reconcile pass's source of truth. */
export interface ArmedAlarm {
  occurrenceKey: string;
  triggerAtMs: number;
  /**
   * Which channel it is armed on. Part of the diff (Sprint A5): Shabbat beginning or ending
   * between two reconciles changes the channel of a dose whose time has not moved, and an alarm
   * left on the weekday channel during Shabbat rings with "Taken"/"Snooze" buttons.
   */
  channelId: MedGuardChannelId;
}

/** A rotated FCM registration token, handed over the moment Firebase issues it. */
export interface PushTokenEvent {
  token: string;
}

export interface MedGuardAlarmsModuleEvents {
  onPendingAction(event: PendingActionEvent): void;
  onPushToken(event: PushTokenEvent): void;
}
