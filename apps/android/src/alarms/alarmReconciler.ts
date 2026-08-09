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
    // A moved trigger is the snooze path and the schedule-edit path: same occurrence, new time.
    return existing === undefined || existing.triggerAtMs !== alarm.triggerAtMs;
  });

  // Anything armed that is no longer planned: the dose was logged, the schedule was stopped, the
  // medicine was archived, or the occurrence has simply fallen out of the horizon behind us.
  const toCancel = armed
    .map((record) => record.occurrenceKey)
    .filter((key) => !plannedKeys.has(key));

  return { toArm, toCancel };
}
