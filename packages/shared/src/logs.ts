import { fromIso } from './clock.js';
import type { IntakeLog, Uuid } from './types.js';

/**
 * Reading an append-only intake history (safety invariant 1).
 *
 * Corrections never edit or delete: they append a new log naming the mistaken one via
 * `supersedesId`. So "what actually happened" is never simply "every row" — it is every row that
 * nothing later replaced. Getting this wrong in either direction is a safety bug: counting a
 * superseded dose inflates the rolling-24h total, and dropping a correction loses a real dose.
 */

/**
 * The logs that represent current truth: every log not replaced by a later correction.
 *
 * Chains are followed transitively — a correction can itself be corrected — so only the tip of
 * each chain survives.
 */
export function effectiveLogs(logs: readonly IntakeLog[]): IntakeLog[] {
  const superseded = new Set<Uuid>();
  for (const log of logs) {
    if (log.supersedesId !== undefined) {
      superseded.add(log.supersedesId);
    }
  }
  return logs.filter((log) => !superseded.has(log.id));
}

/**
 * Effective logs for one medicine, taken by one patient, that record a dose actually administered.
 *
 * Scoped by `patientId` as well as `medicineId` because a shared medicine (one `Medicine` row
 * several patients take) has one cooldown/cap *limit*, but each patient's doses are counted
 * against it independently — Dad taking his dose must not put Mom in cooldown for hers.
 */
export function administeredDoses(
  logs: readonly IntakeLog[],
  medicineId: Uuid,
  patientId: Uuid,
): IntakeLog[] {
  return effectiveLogs(logs).filter(
    (log) => log.medicineId === medicineId && log.patientId === patientId && log.status === 'taken',
  );
}

/** Most recent first. */
export function sortByActualTimeDesc(logs: readonly IntakeLog[]): IntakeLog[] {
  return [...logs].sort((a, b) => fromIso(b.actualTime) - fromIso(a.actualTime));
}

/**
 * The most recently administered dose of a medicine by one patient, or undefined if there is none.
 *
 * "Most recent" is by `actualTime` — when the dose was given — not by insertion order, because a
 * dose given during Shabbat may be logged hours later during reconciliation (PRD §3).
 */
export function lastAdministeredDose(
  logs: readonly IntakeLog[],
  medicineId: Uuid,
  patientId: Uuid,
): IntakeLog | undefined {
  return sortByActualTimeDesc(administeredDoses(logs, medicineId, patientId))[0];
}
