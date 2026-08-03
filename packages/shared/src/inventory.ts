import type { Clock, IdGenerator, IsoInstant } from './clock.js';
import { scheduleIsLiveOn } from './schedule.js';
import type {
  DeviceId,
  InventoryAdjustment,
  InventoryItem,
  IntakeLog,
  LocalDate,
  Schedule,
  UserId,
  Uuid,
} from './types.js';

/**
 * Stock as an append-only ledger.
 *
 * The PRD modelled inventory as a mutable `currentQuantity`. Under Last-Write-Wins that silently
 * loses doses: two caregivers each logging a dose offline both write `n - 1`, one write wins, and
 * the count drifts up by one — quietly corrupting the refill alerts that tell a family whether a
 * child will run out of chemotherapy. Summing immutable deltas cannot lose a decrement.
 *
 * Pure: no clock reads and no I/O, so every arithmetic path is directly testable.
 */

/**
 * Quantities can be fractional (half a tablet, 2.5ml), and repeated float addition drifts —
 * summing 0.1 ten times gives 0.9999999999999999. Rounding at this precision keeps the ledger
 * exact for any realistic dose while never being visible to a caregiver.
 */
const QUANTITY_PRECISION = 1e6;

function round(value: number): number {
  return Math.round(value * QUANTITY_PRECISION) / QUANTITY_PRECISION;
}

/**
 * Net stock from a ledger, deduplicated by adjustment id.
 *
 * Deduplication is what makes the ledger idempotent: sync retries and reconnect replays deliver
 * the same adjustment more than once, and counting it twice would decrement stock for a dose that
 * was only given once.
 */
export function computeQuantity(adjustments: readonly InventoryAdjustment[]): number {
  const seen = new Set<Uuid>();
  let total = 0;

  for (const adjustment of adjustments) {
    if (seen.has(adjustment.id)) {
      continue;
    }
    seen.add(adjustment.id);
    total += adjustment.delta;
  }

  return round(total);
}

export interface InventoryState {
  medicineId: Uuid;
  currentQuantity: number;
  refillThreshold: number;
  unitName: string;
  /** At or below the refill threshold — time to order more. */
  isLow: boolean;
  /**
   * Stock has gone below zero, which means the ledger disagrees with reality: doses were logged
   * that the recorded stock could not have covered. Surfaced rather than clamped, because
   * clamping would hide a real bookkeeping error (safety invariant 6).
   */
  isNegative: boolean;
  lastRefilledAt?: IsoInstant;
}

export function deriveInventoryState(
  item: InventoryItem,
  adjustments: readonly InventoryAdjustment[],
): InventoryState {
  const forThisMedicine = adjustments.filter(
    (adjustment) => adjustment.medicineId === item.medicineId,
  );
  const currentQuantity = computeQuantity(forThisMedicine);

  return {
    medicineId: item.medicineId,
    currentQuantity,
    refillThreshold: item.refillThreshold,
    unitName: item.unitName,
    isLow: currentQuantity <= item.refillThreshold,
    isNegative: currentQuantity < 0,
    ...(item.lastRefilledAt !== undefined ? { lastRefilledAt: item.lastRefilledAt } : {}),
  };
}

export interface AdjustmentContext {
  clock: Clock;
  ids: IdGenerator;
  userId: UserId;
  deviceId: DeviceId;
}

/**
 * The ledger entry for an administered dose.
 *
 * Carries `relatedLogId` so a later correction can find and reverse exactly this entry rather
 * than guessing which decrement belonged to which dose.
 */
export function buildDoseAdjustment(
  log: IntakeLog,
  { clock, ids, userId, deviceId }: AdjustmentContext,
): InventoryAdjustment {
  return {
    id: ids.next(),
    medicineId: log.medicineId,
    delta: -Math.abs(log.quantityTaken),
    reason: 'dose',
    relatedLogId: log.id,
    createdAt: clock.nowIso(),
    createdByUserId: userId,
    createdByDeviceId: deviceId,
    syncStatus: 'pending',
  };
}

/**
 * Reverses an earlier adjustment by appending its opposite — never by deleting it.
 *
 * A correction has to leave the original visible: "we thought we gave 2, we actually gave 1" is
 * information a clinician may need, and a ledger you can delete from is not an audit trail.
 */
export function buildReversalAdjustment(
  original: InventoryAdjustment,
  { clock, ids, userId, deviceId }: AdjustmentContext,
  note = 'Reversal of a corrected dose',
): InventoryAdjustment {
  return {
    id: ids.next(),
    medicineId: original.medicineId,
    delta: -original.delta,
    reason: 'correction',
    ...(original.relatedLogId !== undefined ? { relatedLogId: original.relatedLogId } : {}),
    createdAt: clock.nowIso(),
    createdByUserId: userId,
    createdByDeviceId: deviceId,
    note,
    syncStatus: 'pending',
  };
}

export interface ManualAdjustmentInput {
  medicineId: Uuid;
  /** Signed: negative for a loss, positive for a refill. */
  delta: number;
  reason: Extract<InventoryAdjustment['reason'], 'initial' | 'refill' | 'correction' | 'lost'>;
  note?: string;
}

/** A caregiver-entered change: an initial count, a refill, a dropped pill, a recount. */
export function buildManualAdjustment(
  input: ManualAdjustmentInput,
  { clock, ids, userId, deviceId }: AdjustmentContext,
): InventoryAdjustment {
  return {
    id: ids.next(),
    medicineId: input.medicineId,
    delta: input.delta,
    reason: input.reason,
    createdAt: clock.nowIso(),
    createdByUserId: userId,
    createdByDeviceId: deviceId,
    ...(input.note !== undefined ? { note: input.note } : {}),
    syncStatus: 'pending',
  };
}

/**
 * The adjustment recorded for a given intake log, if any.
 *
 * Used when correcting a dose, to find the decrement that needs reversing.
 */
export function adjustmentForLog(
  adjustments: readonly InventoryAdjustment[],
  logId: Uuid,
): InventoryAdjustment | undefined {
  return adjustments.find(
    (adjustment) => adjustment.reason === 'dose' && adjustment.relatedLogId === logId,
  );
}

// ---------------------------------------------------------------------------
// Refill projection
// ---------------------------------------------------------------------------

/**
 * A schedule's average daily consumption, computed analytically rather than by expanding
 * occurrences over some sample window — exact for any interval, not an approximation that
 * happens to be close for the window chosen.
 */
function dailyConsumptionFor(schedule: Schedule): number {
  const perOccurrence = schedule.timesOfDay.length * schedule.dosageQuantity;

  switch (schedule.frequencyType) {
    case 'daily':
      return perOccurrence;

    case 'interval_days': {
      // Defensive rather than redundant, matching schedule.ts: schemas guarantee this on the
      // way in, but this also runs over rows already in IndexedDB that may predate a schema
      // change.
      const interval = schedule.intervalDays;
      if (interval === undefined || interval < 1) {
        return 0;
      }
      return perOccurrence / interval;
    }

    case 'specific_days': {
      const days = schedule.daysOfWeek;
      if (days === undefined) {
        return 0;
      }
      return (perOccurrence * days.length) / 7;
    }
  }
}

/**
 * Average daily consumption of one medicine, as of `onDate`, summed across every currently-live
 * schedule for it.
 *
 * Summing matters for an alternating regimen (50mg Mon/Wed/Fri, 25mg Tue/Thu/Sat): it's modelled
 * as two schedules for the same medicine, and both contribute to how fast the bottle actually
 * empties.
 */
export function estimateDailyConsumption(
  schedules: readonly Schedule[],
  medicineId: Uuid,
  onDate: LocalDate,
): number {
  return schedules
    .filter((schedule) => schedule.medicineId === medicineId && scheduleIsLiveOn(schedule, onDate))
    .reduce((total, schedule) => total + dailyConsumptionFor(schedule), 0);
}

/**
 * How many days of supply remain at the current consumption rate.
 *
 * `null` rather than `Infinity` when nothing is being consumed — "forever" is not a projection a
 * caregiver can act on, and displaying it invites exactly the confusion a real number would not.
 */
export function daysOfSupply(currentQuantity: number, dailyConsumption: number): number | null {
  if (dailyConsumption <= 0) {
    return null;
  }
  if (currentQuantity <= 0) {
    return 0;
  }
  return currentQuantity / dailyConsumption;
}
