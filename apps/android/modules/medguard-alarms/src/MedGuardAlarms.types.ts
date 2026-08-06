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
  /** Epoch milliseconds at the instant the user tapped — not the instant JS drains it (AD2). */
  tappedAtMs: number;
}

export interface MedGuardAlarmsModuleEvents {
  onPendingAction(event: PendingActionEvent): void;
}
