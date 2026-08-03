import { effectiveLogs } from '@medguard/shared';
import type { IntakeLog, Occurrence } from '@medguard/shared';

/**
 * The log recorded for a scheduled occurrence, if any.
 *
 * Correlated by `(scheduleId, scheduledTime)` rather than by matching `actualTime` against the
 * occurrence's window: a dose can be logged well after its due time (late, or during Motzei
 * Shabbat reconciliation), so `actualTime` won't line up with `dueAt` — `scheduledTime` is what
 * a scheduled log stamps with the occurrence it answers, and stays exact regardless of when the
 * log was actually written.
 */
export function findLogForOccurrence(
  logs: readonly IntakeLog[],
  occurrence: Occurrence,
): IntakeLog | undefined {
  return effectiveLogs(logs).find(
    (log) => log.scheduleId === occurrence.scheduleId && log.scheduledTime === occurrence.dueAt,
  );
}
