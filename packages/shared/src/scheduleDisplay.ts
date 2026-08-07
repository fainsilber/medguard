import type { Schedule } from './types.js';

/** `daysOfWeek` is `0 = Sunday … 6 = Saturday`, matching `packages/shared/src/types.ts`. */
export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A one-line human summary of a schedule, for list rows. Pure formatting — no time, no I/O. */
export function describeSchedule(schedule: Schedule): string {
  const timePart = schedule.timesOfDay.join(', ');

  const frequencyPart =
    schedule.frequencyType === 'daily'
      ? 'Every day'
      : schedule.frequencyType === 'interval_days'
        ? `Every ${schedule.intervalDays ?? '?'} days`
        : (schedule.daysOfWeek ?? []).map((day) => DAY_LABELS[day]).join('/') || 'No days selected';

  return `${frequencyPart} at ${timePart} — ${schedule.dosageQuantity}`;
}
