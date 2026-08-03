import { fromIso, isClockTrusted, toIso } from './clock.js';
import type { Clock, ClockTrust, EpochMs, IsoInstant } from './clock.js';
import { administeredDoses } from './logs.js';
import { MS_PER_HOUR } from './timezone.js';
import type { IntakeLog, Medicine, UserId } from './types.js';

/**
 * PRN safety guards: the minimum interval between doses and the rolling dose cap.
 *
 * This is the module the whole project exists to get right. Two rules govern every decision
 * here, from the sprint plan's safety invariants:
 *
 *   3. Fail closed, never open — if the answer is unknown, the answer is "blocked".
 *   2. The app never calculates or suggests a dose — it only reports whether one is permitted.
 *
 * Pure and total: no clock reads, no I/O, no exceptions on ordinary input.
 */

/** PRD §2.3 — the cap is a rolling 24-hour window, not a calendar day. */
export const ROLLING_WINDOW_MS = 24 * MS_PER_HOUR;

export interface LastDoseSummary {
  atIso: IsoInstant;
  quantity: number;
  byUserId: UserId;
}

/**
 * Why a dose is blocked, in the vocabulary the override audit record uses
 * (`DoseOverride.blockedBy`).
 */
export type BlockReason = 'cooldown' | 'daily_cap' | 'untrusted_clock';

/**
 * The verdict for one medicine at one instant.
 *
 * `cooldown` and `capped` are deliberately distinct states rather than one "blocked": they mean
 * different things to a caregiver at 3am — one is "wait a bit", the other is "not again today" —
 * and the PRD calls for different messages.
 */
export type DoseSafety =
  | { state: 'safe'; lastDose?: LastDoseSummary }
  | {
      state: 'cooldown';
      lastDose: LastDoseSummary;
      msRemaining: number;
      availableAtIso: IsoInstant;
    }
  | {
      state: 'capped';
      lastDose: LastDoseSummary;
      dosesInWindow: number;
      maxDailyDoses: number;
      msRemaining: number;
      availableAtIso: IsoInstant;
    }
  | { state: 'untrusted_clock'; lastDose?: LastDoseSummary };

/** Maps a verdict onto the reason recorded when a caregiver overrides it. */
export function blockReasonFor(safety: DoseSafety): BlockReason | undefined {
  switch (safety.state) {
    case 'safe':
      return undefined;
    case 'cooldown':
      return 'cooldown';
    case 'capped':
      return 'daily_cap';
    case 'untrusted_clock':
      return 'untrusted_clock';
  }
}

function summarise(log: IntakeLog): LastDoseSummary {
  return { atIso: log.actualTime, quantity: log.quantityTaken, byUserId: log.loggedByUserId };
}

/**
 * Doses of this medicine administered within the trailing rolling window, oldest first.
 *
 * Counts *every* administered dose, scheduled as well as PRN: a cap of "4 in 24 hours" is a
 * limit on how much of the drug the patient receives, not on how it was recorded.
 */
export function dosesInRollingWindow(
  logs: readonly IntakeLog[],
  medicineId: string,
  nowMs: EpochMs,
  windowMs: number = ROLLING_WINDOW_MS,
): IntakeLog[] {
  const windowStart = nowMs - windowMs;
  return administeredDoses(logs, medicineId)
    .filter((log) => {
      const at = fromIso(log.actualTime);
      // Future-dated doses count too. A dose logged slightly ahead of `now` (clock skew between
      // caregivers' phones) must not fall outside the window and silently free up capacity.
      return at > windowStart;
    })
    .sort((a, b) => fromIso(a.actualTime) - fromIso(b.actualTime));
}

/**
 * When the rolling cap will next permit a dose, given the doses currently in the window.
 *
 * With `N` doses inside the window and a cap of `M`, enough of the oldest must age out to leave
 * room for one more, so the binding dose is the `(N - M + 1)`th oldest. Handles `N > M`, which
 * happens legitimately after an override.
 */
function capAvailableAtMs(dosesAscending: readonly IntakeLog[], maxDailyDoses: number): EpochMs {
  const bindingIndex = Math.max(0, dosesAscending.length - maxDailyDoses);
  // Non-null is guaranteed by the caller, which only reaches this with a window at least
  // `maxDailyDoses` long and a cap of at least one.
  return fromIso(dosesAscending[bindingIndex]!.actualTime) + ROLLING_WINDOW_MS;
}

export interface AssessDoseInput {
  medicine: Medicine;
  /** The full local history for this medicine. Superseded corrections are filtered internally. */
  logs: readonly IntakeLog[];
  clock: Clock;
  /**
   * Whether this device's clock has been verified against the server (delta D7).
   *
   * An unverified clock cannot be used to prove a cooldown has elapsed, so a guarded medicine
   * blocks rather than showing green — invariant 3.
   */
  clockTrust: ClockTrust;
}

export function assessDose({ medicine, logs, clock, clockTrust }: AssessDoseInput): DoseSafety {
  const nowMs = clock.nowMs();
  const window = dosesInRollingWindow(logs, medicine.id, nowMs);
  const mostRecent = window.at(-1);
  const lastDose = mostRecent ? summarise(mostRecent) : undefined;

  const hasGuard =
    medicine.minHoursBetweenDoses !== undefined || medicine.maxDailyDoses !== undefined;

  // An untrusted clock only matters where a time-based rule depends on it. Blocking medicines
  // that have no guard configured would be noise, and noise is what trains people to tap through
  // warnings that matter.
  if (hasGuard && !isClockTrusted(clockTrust)) {
    return { state: 'untrusted_clock', ...(lastDose ? { lastDose } : {}) };
  }

  const cooldownAvailableAtMs =
    medicine.minHoursBetweenDoses !== undefined && mostRecent
      ? fromIso(mostRecent.actualTime) + medicine.minHoursBetweenDoses * MS_PER_HOUR
      : undefined;

  // A non-positive cap is corrupt data, not a real limit — the schema forbids it. It is treated
  // as no cap rather than as an absolute block: inventing a limit the caregiver never configured
  // would withhold a genuinely needed dose, which is its own safety failure. The cooldown guard
  // still applies either way.
  const capIsMeaningful = medicine.maxDailyDoses !== undefined && medicine.maxDailyDoses > 0;

  const capAvailableAt =
    capIsMeaningful && window.length >= medicine.maxDailyDoses!
      ? capAvailableAtMs(window, medicine.maxDailyDoses!)
      : undefined;

  const cooldownBlocks = cooldownAvailableAtMs !== undefined && cooldownAvailableAtMs > nowMs;
  const capBlocks = capAvailableAt !== undefined && capAvailableAt > nowMs;

  // When both bind, report whichever clears later — telling a caregiver "1 hour" when the real
  // wait is twenty would be worse than useless.
  if (capBlocks && (!cooldownBlocks || capAvailableAt >= cooldownAvailableAtMs!)) {
    return {
      state: 'capped',
      lastDose: lastDose!,
      dosesInWindow: window.length,
      maxDailyDoses: medicine.maxDailyDoses!,
      msRemaining: capAvailableAt - nowMs,
      availableAtIso: toIso(capAvailableAt),
    };
  }

  if (cooldownBlocks) {
    return {
      state: 'cooldown',
      lastDose: lastDose!,
      msRemaining: cooldownAvailableAtMs - nowMs,
      availableAtIso: toIso(cooldownAvailableAtMs),
    };
  }

  return { state: 'safe', ...(lastDose ? { lastDose } : {}) };
}

/** Convenience for the UI: is the action button enabled? */
export function isDosePermitted(safety: DoseSafety): boolean {
  return safety.state === 'safe';
}
