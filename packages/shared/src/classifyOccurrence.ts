import { fromIso } from './clock.js';
import type { EpochMs, IsoInstant } from './clock.js';
import type { IntakeStatus } from './types.js';

/**
 * Which bucket a scheduled occurrence falls into on the Today view.
 *
 * Pure — takes `nowMs` as a parameter rather than reading it, so this is directly testable and
 * so the no-ambient-time lint rule has nothing to object to. `snoozed` is a Sprint 2
 * approximation: it's local display state only (see TodayView.tsx), not a real alarm that rings
 * again in 15 minutes — that arrives with Sprint 5's alarm engine.
 *
 * `pending_shabbat` is a bucket of its own (Sprint A5) rather than a kind of `done`: the dose has
 * a log, but the log says only "this alert fired during Shabbat and nobody has recorded what
 * happened yet". Showing it as done would tell a caregiver the dose was dealt with, which is the
 * one thing the Motzei reconciliation exists to establish.
 */
export type OccurrenceStatus =
  | 'done'
  | 'overdue'
  | 'due_now'
  | 'upcoming'
  | 'snoozed'
  | 'pending_shabbat';

/** How long after its due time an occurrence still reads as "due now" rather than "overdue". */
export const DUE_NOW_WINDOW_MS = 5 * 60_000;

/**
 * @param logStatus the effective log's status, or `undefined` when the occurrence has no log.
 *   A status rather than a boolean because not every log answers the question the alert asked.
 */
export function classifyOccurrence(
  dueAtIso: IsoInstant,
  nowMs: EpochMs,
  logStatus: IntakeStatus | undefined,
  snoozedUntilMs?: EpochMs,
): OccurrenceStatus {
  if (logStatus === 'pending_shabbat') {
    return 'pending_shabbat';
  }
  if (logStatus !== undefined) {
    return 'done';
  }
  if (snoozedUntilMs !== undefined && nowMs < snoozedUntilMs) {
    return 'snoozed';
  }

  const dueMs = fromIso(dueAtIso);
  if (dueMs > nowMs) {
    return 'upcoming';
  }
  if (nowMs - dueMs <= DUE_NOW_WINDOW_MS) {
    return 'due_now';
  }
  return 'overdue';
}
