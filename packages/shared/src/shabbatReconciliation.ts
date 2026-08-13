import { fromIso } from './clock.js';
import type { EpochMs } from './clock.js';
import { effectiveLogs } from './logs.js';
import { findLogForOccurrence } from './matchOccurrenceLog.js';
import { expandSchedules, occurrenceKey } from './schedule.js';
import type { Occurrence } from './schedule.js';
import { activeWindow } from './shabbat.js';
import type { IntakeLog, Medicine, Schedule, ShabbatWindow } from './types.js';

/**
 * What the Motzei Shabbat reconciliation sheet has to ask about (Sprint A5 phase 2).
 *
 * Pure, and shared so both clients ask the same question of the same data. During Shabbat nothing
 * is recorded; after Havdalah a caregiver says what actually happened, and this is the list they
 * are saying it about.
 *
 * **Derived from the window, not from the pending logs.** The Durable Object writes a
 * `pending_shabbat` log when a dose alert fires, but a household whose server never woke — or
 * whose phone was offline all of Shabbat — still gave those doses, and a list built only from the
 * logs that happen to exist would silently skip them. Expanding the schedules across the window is
 * what makes the sheet complete rather than merely consistent.
 */

export interface ReconciliationItem {
  /** Stable identity, and the React key: `${scheduleId}:${dueAt}`. */
  key: string;
  occurrence: Occurrence;
  /** For display — the sheet lists doses, and a dose without its medicine's name is unanswerable. */
  medicineName: string;
  /**
   * The `pending_shabbat` log the server recorded when the alert fired, when there is one.
   *
   * Present means the reconciliation *supersedes* that log (safety invariant 1 — a correction
   * appends, never edits). Absent means nothing was ever recorded for this dose and the
   * reconciliation writes a first log for it.
   */
  pendingLog?: IntakeLog;
}

export interface CollectReconciliationInput {
  /** The published windows this device holds. Only ones that have ended are reconcilable. */
  windows: readonly ShabbatWindow[];
  schedules: readonly Schedule[];
  medicines: readonly Medicine[];
  logs: readonly IntakeLog[];
  /** The household's fixed zone — the same one every dose time resolves through. */
  timeZone: string;
  nowMs: EpochMs;
  /**
   * How far back to look. A caregiver reconciles the Shabbat that just ended, not the whole year;
   * anything older than this was either dealt with or has become a matter for the log screen.
   */
  lookbackMs?: number;
}

/** Two weeks: comfortably more than one missed Motzei, far less than "all of history". */
export const RECONCILIATION_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Every dose from a finished Shabbat window that still owes an answer, earliest first.
 *
 * An occurrence is listed unless one of these is true:
 *
 * - **it has a real log** — taken, skipped, or a `missed` written before the window began. A
 *   `pending_shabbat` log is explicitly *not* a real log here: it is the record of the question,
 *   not of the answer, which is the whole reason this sheet exists.
 * - **its medicine is archived or missing** — nobody gives it any more.
 * - **its window has not ended** — reconciliation happens after Havdalah, not during.
 *
 * PRN doses never appear: they have no scheduled occurrence to reconcile. Retroactive PRN entry is
 * a separate affordance on the sheet, because "was this scheduled dose given?" and "did you give
 * something as needed?" are different questions.
 */
export function collectReconciliationItems(
  input: CollectReconciliationInput,
): ReconciliationItem[] {
  const { windows, schedules, medicines, logs, timeZone, nowMs } = input;
  const lookbackMs = input.lookbackMs ?? RECONCILIATION_LOOKBACK_MS;

  const finished = windows.filter((window) => {
    const endMs = fromIso(window.endsAt);
    return endMs <= nowMs && endMs >= nowMs - lookbackMs;
  });

  if (finished.length === 0) {
    return [];
  }

  const medicinesById = new Map(medicines.map((medicine) => [medicine.id, medicine]));
  const effective = effectiveLogs(logs);
  const items: ReconciliationItem[] = [];
  const seen = new Set<string>();

  for (const window of finished) {
    const occurrences = expandSchedules(
      schedules,
      { fromMs: fromIso(window.startsAt), toMs: fromIso(window.endsAt) },
      timeZone,
    );

    for (const occurrence of occurrences) {
      const key = occurrenceKey(occurrence);
      // Two windows cannot overlap, but a schedule edit mid-window can produce the same occurrence
      // from two schedule versions; a caregiver must be asked about a dose once.
      if (seen.has(key)) {
        continue;
      }

      const medicine = medicinesById.get(occurrence.medicineId);
      if (!medicine || medicine.archived) {
        continue;
      }

      const log = findLogForOccurrence(effective, occurrence);
      if (log !== undefined && log.status !== 'pending_shabbat') {
        continue;
      }

      seen.add(key);
      items.push({
        key,
        occurrence,
        medicineName: medicine.name,
        ...(log ? { pendingLog: log } : {}),
      });
    }
  }

  return items.sort((a, b) => fromIso(a.occurrence.dueAt) - fromIso(b.occurrence.dueAt));
}

/**
 * Whether anything is still owed — the fact `shabbatPhaseAt` takes as `hasUnreconciledDoses`, and
 * therefore what makes `motzei_pending` a state the app can actually be in rather than one the
 * type system merely allows.
 */
export function hasUnreconciledDoses(items: readonly ReconciliationItem[]): boolean {
  return items.length > 0;
}

/**
 * Whether reconciliation is *possible* right now: a window has ended and nothing new has begun.
 *
 * Distinct from having items — a household with nothing owed still ended a Shabbat, and the sheet
 * should not open mid-chag to ask about doses that are still being deferred.
 */
export function isReconcilableAt(
  windows: readonly ShabbatWindow[],
  nowMs: EpochMs,
): boolean {
  return activeWindow(windows, nowMs) === undefined;
}
