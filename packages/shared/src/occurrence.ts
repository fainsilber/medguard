import { fromIso } from './clock.js';
import type { EpochMs, IsoInstant } from './clock.js';

/**
 * Which bucket a scheduled occurrence falls into on the Today view.
 *
 * Pure — takes `nowMs` as a parameter rather than reading it, so this is directly testable and
 * so the no-ambient-time lint rule has nothing to object to. `snoozed` is a Sprint 2
 * approximation: it's local display state only (see apps/web/src/features/today/TodayView.tsx),
 * not a real alarm that rings again in 15 minutes — that arrives with Sprint 5's alarm engine.
 *
 * Shared rather than per-client so both the PWA and the Android client agree on what "overdue"
 * means and on the width of the due-now window (docs/android-client-plan.md, "Storage and the
 * sync port").
 */
export type OccurrenceStatus = 'done' | 'overdue' | 'due_now' | 'upcoming' | 'snoozed';

/** How long after its due time an occurrence still reads as "due now" rather than "overdue". */
export const DUE_NOW_WINDOW_MS = 5 * 60_000;

export function classifyOccurrence(
  dueAtIso: IsoInstant,
  nowMs: EpochMs,
  hasLog: boolean,
  snoozedUntilMs?: EpochMs,
): OccurrenceStatus {
  if (hasLog) {
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
