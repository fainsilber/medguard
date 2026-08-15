import type { PlannedAlarm } from './horizon.js';

/**
 * Diffing "what should be armed" against "what Android actually has armed".
 *
 * Pure, and separate from the engine on purpose: this is the logic that decides whether a
 * caregiver's phone rings, and it should be provable without a device.
 *
 * Re-arming everything unconditionally would be simpler and wrong. `setAlarmClock` surfaces an
 * upcoming-alarm affordance in the system UI, so churning every alarm on every sync write would
 * flicker it constantly; and each re-arm is a `PendingIntent` replacement that briefly leaves a
 * window where the alarm is neither the old one nor the new one.
 */

export interface ArmedRecord {
  occurrenceKey: string;
  triggerAtMs: number;
  /**
   * The channel it is armed on. Optional so a device upgrading from a build that did not report
   * it is not treated as having every alarm on the wrong channel — an unknown channel simply is
   * not a reason to re-arm, and the next genuine change re-arms anyway.
   */
  channelId?: string;
  /**
   * How long it is armed to ring for. Optional for the same reason as `channelId` — a build that
   * did not report it must not look like every alarm needs re-arming.
   */
  chimeDurationSeconds?: number;
}

export interface AlarmDiff {
  toArm: PlannedAlarm[];
  toCancel: string[];
}

export function diffAlarms(
  armed: readonly ArmedRecord[],
  planned: readonly PlannedAlarm[],
): AlarmDiff {
  const armedByKey = new Map(armed.map((record) => [record.occurrenceKey, record]));
  const plannedKeys = new Set(planned.map((alarm) => alarm.occurrenceKey));

  const toArm = planned.filter((alarm) => {
    const existing = armedByKey.get(alarm.occurrenceKey);
    if (existing === undefined) {
      return true;
    }
    // A moved trigger is the snooze path and the schedule-edit path: same occurrence, new time.
    if (existing.triggerAtMs !== alarm.triggerAtMs) {
      return true;
    }
    // A moved channel is the Shabbat path (Sprint A5): same occurrence, same time, but Shabbat
    // began or ended since it was armed. Left alone, a dose armed on Thursday for Friday night
    // would ring on the weekday channel — with the "Taken" and "Snooze" buttons that must not
    // exist on Shabbat.
    if (existing.channelId !== undefined && existing.channelId !== alarm.channelId) {
      return true;
    }
    // A changed length: a caregiver edited one of the two alert lengths on the Shabbat screen.
    // The duration travels inside the alarm payload, so an armed alarm keeps the old number until
    // it is re-armed — meaning the setting would appear to do nothing for up to 48 hours.
    return (
      existing.chimeDurationSeconds !== undefined &&
      existing.chimeDurationSeconds !== alarm.chimeDurationSeconds
    );
  });

  // Anything armed that is no longer planned: the dose was logged, the schedule was stopped, the
  // medicine was archived, or the occurrence has simply fallen out of the horizon behind us.
  const toCancel = armed
    .map((record) => record.occurrenceKey)
    .filter((key) => !plannedKeys.has(key));

  return { toArm, toCancel };
}
