import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  adjustmentForLog,
  buildDoseAdjustment,
  buildManualAdjustment,
  buildReversalAdjustment,
  computeQuantity,
  daysOfSupply,
  deriveInventoryState,
  estimateDailyConsumption,
} from './inventory.js';
import { fixedClock, sequentialIds } from './testing.js';
import type { InventoryAdjustment, InventoryItem, IntakeLog, Schedule } from './types.js';

const NOW = '2026-06-15T12:00:00.000Z';

function context(prefix = 'adj') {
  return {
    clock: fixedClock(NOW),
    ids: sequentialIds(prefix),
    userId: 'mom',
    deviceId: 'device-1',
  };
}

function adjustment(overrides: Partial<InventoryAdjustment> = {}): InventoryAdjustment {
  return {
    id: 'adjustment-1',
    medicineId: 'medicine-1',
    delta: -1,
    reason: 'dose',
    createdAt: NOW,
    createdByUserId: 'mom',
    createdByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'inventory-1',
    medicineId: 'medicine-1',
    refillThreshold: 5,
    unitName: 'pills',
    updatedAt: NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function intakeLog(overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id: 'log-1',
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    type: 'prn',
    status: 'taken',
    actualTime: NOW,
    quantityTaken: 1,
    loggedByUserId: 'mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('computeQuantity', () => {
  it('is zero for an empty ledger', () => {
    expect(computeQuantity([])).toBe(0);
  });

  it('sums deltas', () => {
    expect(
      computeQuantity([
        adjustment({ id: 'a', delta: 30, reason: 'initial' }),
        adjustment({ id: 'b', delta: -1 }),
        adjustment({ id: 'c', delta: -1 }),
      ]),
    ).toBe(28);
  });

  it('is idempotent — a replayed adjustment is counted once', () => {
    // Sync retries and reconnect replays deliver the same row again; counting it twice would
    // decrement stock for a dose that was only given once.
    const duplicate = adjustment({ id: 'same', delta: -1 });
    expect(computeQuantity([adjustment({ id: 'a', delta: 10, reason: 'initial' }), duplicate, duplicate])).toBe(9);
  });

  it('keeps fractional quantities exact instead of drifting', () => {
    // Ten half-tablets. Naive float addition gives 4.999999999999999.
    const halves = Array.from({ length: 10 }, (_, i) => adjustment({ id: `h${i}`, delta: -0.1 }));
    expect(computeQuantity([adjustment({ id: 'start', delta: 5, reason: 'initial' }), ...halves])).toBe(4);
  });

  it('reports a negative total rather than clamping it', () => {
    // Clamping would hide a real bookkeeping error — more doses logged than stock could cover.
    expect(computeQuantity([adjustment({ id: 'a', delta: 1, reason: 'initial' }), adjustment({ id: 'b', delta: -3 })])).toBe(-2);
  });
});

describe('the concurrent-decrement case an append-only ledger exists for', () => {
  it('keeps both decrements when two caregivers dose offline at once', () => {
    // Under the PRD's original mutable counter, both devices would have written
    // `currentQuantity = 9` and one write would have been silently discarded.
    const ledger = [
      adjustment({ id: 'start', delta: 10, reason: 'initial' }),
      adjustment({ id: 'mom-dose', delta: -1, createdByDeviceId: 'mom-phone' }),
      adjustment({ id: 'dad-dose', delta: -1, createdByDeviceId: 'dad-phone' }),
    ];
    expect(computeQuantity(ledger)).toBe(8);
  });

  it('gives the same answer whatever order the adjustments sync in', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -5, max: 5 }), { maxLength: 20 }), (deltas) => {
        const ledger = deltas
          .filter((delta) => delta !== 0)
          .map((delta, index) => adjustment({ id: `a${index}`, delta }));
        const shuffled = [...ledger].reverse();
        return computeQuantity(ledger) === computeQuantity(shuffled);
      }),
    );
  });
});

describe('deriveInventoryState', () => {
  it('reports the current quantity', () => {
    const state = deriveInventoryState(item(), [
      adjustment({ id: 'a', delta: 30, reason: 'initial' }),
      adjustment({ id: 'b', delta: -2 }),
    ]);
    expect(state.currentQuantity).toBe(28);
    expect(state.unitName).toBe('pills');
  });

  it('ignores adjustments belonging to another medicine', () => {
    const state = deriveInventoryState(item(), [
      adjustment({ id: 'a', delta: 10, reason: 'initial' }),
      adjustment({ id: 'b', delta: -5, medicineId: 'other-medicine' }),
    ]);
    expect(state.currentQuantity).toBe(10);
  });

  it('flags low stock at the threshold, not only below it', () => {
    const atThreshold = deriveInventoryState(item({ refillThreshold: 5 }), [
      adjustment({ id: 'a', delta: 5, reason: 'initial' }),
    ]);
    expect(atThreshold.isLow).toBe(true);
  });

  it('does not flag low stock above the threshold', () => {
    const above = deriveInventoryState(item({ refillThreshold: 5 }), [
      adjustment({ id: 'a', delta: 6, reason: 'initial' }),
    ]);
    expect(above.isLow).toBe(false);
  });

  it('flags a negative balance', () => {
    const state = deriveInventoryState(item(), [adjustment({ id: 'a', delta: -2 })]);
    expect(state.isNegative).toBe(true);
    expect(state.isLow).toBe(true);
  });

  it('carries the last refill time when set', () => {
    const state = deriveInventoryState(item({ lastRefilledAt: NOW }), []);
    expect(state.lastRefilledAt).toBe(NOW);
  });

  it('omits the last refill time when never refilled', () => {
    expect(deriveInventoryState(item(), []).lastRefilledAt).toBeUndefined();
  });
});

describe('buildDoseAdjustment', () => {
  it('records a negative delta linked back to the dose', () => {
    const built = buildDoseAdjustment(intakeLog({ id: 'log-9', quantityTaken: 2 }), context());

    expect(built.delta).toBe(-2);
    expect(built.reason).toBe('dose');
    expect(built.relatedLogId).toBe('log-9');
    expect(built.syncStatus).toBe('pending');
    expect(built.createdAt).toBe(NOW);
  });

  it('consumes stock even if a quantity arrives already negative', () => {
    // Defensive: a dose must never *add* stock, whatever sign the caller passed.
    const built = buildDoseAdjustment(intakeLog({ quantityTaken: -3 }), context());
    expect(built.delta).toBe(-3);
  });
});

describe('buildReversalAdjustment', () => {
  it('appends the opposite delta rather than deleting the original', () => {
    const original = adjustment({ id: 'dose-adj', delta: -2, relatedLogId: 'log-1' });
    const reversal = buildReversalAdjustment(original, context('rev'));

    expect(reversal.delta).toBe(2);
    expect(reversal.reason).toBe('correction');
    expect(reversal.relatedLogId).toBe('log-1');
    expect(reversal.id).not.toBe(original.id);
  });

  it('nets to zero against the adjustment it reverses', () => {
    const original = adjustment({ id: 'dose-adj', delta: -2 });
    const reversal = buildReversalAdjustment(original, context('rev'));
    expect(computeQuantity([original, reversal])).toBe(0);
  });

  it('omits the related log when the original had none', () => {
    const manual = adjustment({ id: 'manual', delta: -1, reason: 'lost' });
    expect(buildReversalAdjustment(manual, context('rev')).relatedLogId).toBeUndefined();
  });

  it('takes a custom note', () => {
    const reversal = buildReversalAdjustment(adjustment(), context('rev'), 'Recount after audit');
    expect(reversal.note).toBe('Recount after audit');
  });
});

describe('buildManualAdjustment', () => {
  it('records a refill', () => {
    const built = buildManualAdjustment(
      { medicineId: 'medicine-1', delta: 30, reason: 'refill', note: 'New box' },
      context(),
    );
    expect(built.delta).toBe(30);
    expect(built.reason).toBe('refill');
    expect(built.note).toBe('New box');
  });

  it('records a loss', () => {
    const built = buildManualAdjustment(
      { medicineId: 'medicine-1', delta: -1, reason: 'lost' },
      context(),
    );
    expect(built.delta).toBe(-1);
    expect(built.note).toBeUndefined();
  });
});

describe('adjustmentForLog', () => {
  it('finds the decrement recorded for a dose', () => {
    const ledger = [
      adjustment({ id: 'other', relatedLogId: 'log-2' }),
      adjustment({ id: 'wanted', relatedLogId: 'log-1' }),
    ];
    expect(adjustmentForLog(ledger, 'log-1')?.id).toBe('wanted');
  });

  it('ignores non-dose adjustments that happen to reference the log', () => {
    const ledger = [adjustment({ id: 'reversal', reason: 'correction', relatedLogId: 'log-1' })];
    expect(adjustmentForLog(ledger, 'log-1')).toBeUndefined();
  });

  it('is undefined when the dose has no ledger entry', () => {
    expect(adjustmentForLog([], 'log-1')).toBeUndefined();
  });
});

describe('correcting a dose end to end', () => {
  it('restores the right stock when a dose is corrected downward', () => {
    const opening = adjustment({ id: 'start', delta: 10, reason: 'initial' });
    const dose = buildDoseAdjustment(intakeLog({ id: 'log-1', quantityTaken: 2 }), context('a'));

    expect(computeQuantity([opening, dose])).toBe(8);

    // Caregiver realises it was one tablet, not two: reverse the original, record the truth.
    const reversal = buildReversalAdjustment(dose, context('b'));
    const corrected = buildDoseAdjustment(intakeLog({ id: 'log-2', quantityTaken: 1 }), context('c'));

    expect(computeQuantity([opening, dose, reversal, corrected])).toBe(9);
  });
});

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    medicineId: 'medicine-1',
    patientId: 'patient-1',
    frequencyType: 'daily',
    timesOfDay: ['08:00'],
    dosageQuantity: 1,
    startDate: '2026-06-01',
    active: true,
    updatedAt: '2026-06-01T00:00:00.000Z',
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('estimateDailyConsumption', () => {
  it('is one dose a day for a once-daily schedule', () => {
    expect(estimateDailyConsumption([makeSchedule()], 'medicine-1', '2026-06-15')).toBe(1);
  });

  it('multiplies by both times of day and dosage quantity', () => {
    const schedule = makeSchedule({ timesOfDay: ['08:00', '20:00'], dosageQuantity: 2 });
    expect(estimateDailyConsumption([schedule], 'medicine-1', '2026-06-15')).toBe(4);
  });

  it('averages an interval schedule over its interval', () => {
    const schedule = makeSchedule({ frequencyType: 'interval_days', intervalDays: 3, dosageQuantity: 2 });
    expect(estimateDailyConsumption([schedule], 'medicine-1', '2026-06-15')).toBeCloseTo(2 / 3);
  });

  it('is zero for an interval schedule missing its interval', () => {
    const schedule = makeSchedule({ frequencyType: 'interval_days' });
    expect(estimateDailyConsumption([schedule], 'medicine-1', '2026-06-15')).toBe(0);
  });

  it('is zero for a nonsensical interval', () => {
    const schedule = makeSchedule({ frequencyType: 'interval_days', intervalDays: 0 });
    expect(estimateDailyConsumption([schedule], 'medicine-1', '2026-06-15')).toBe(0);
  });

  it('averages a specific-days schedule over a week', () => {
    // Three days a week — Mon/Wed/Fri.
    const schedule = makeSchedule({ frequencyType: 'specific_days', daysOfWeek: [1, 3, 5] });
    expect(estimateDailyConsumption([schedule], 'medicine-1', '2026-06-15')).toBeCloseTo(3 / 7);
  });

  it('is zero for a specific-days schedule missing its days', () => {
    const schedule = makeSchedule({ frequencyType: 'specific_days' });
    expect(estimateDailyConsumption([schedule], 'medicine-1', '2026-06-15')).toBe(0);
  });

  it('sums an alternating regimen across both of its schedules', () => {
    // 50mg Mon/Wed/Fri, 25mg Tue/Thu/Sat — two schedules for the same medicine.
    const higher = makeSchedule({
      id: 'high',
      frequencyType: 'specific_days',
      daysOfWeek: [1, 3, 5],
      dosageQuantity: 50,
    });
    const lower = makeSchedule({
      id: 'low',
      frequencyType: 'specific_days',
      daysOfWeek: [2, 4, 6],
      dosageQuantity: 25,
    });

    const result = estimateDailyConsumption([higher, lower], 'medicine-1', '2026-06-15');
    expect(result).toBeCloseTo((3 * 50 + 3 * 25) / 7);
  });

  it('ignores a schedule for a different medicine', () => {
    const schedule = makeSchedule({ medicineId: 'other-medicine' });
    expect(estimateDailyConsumption([schedule], 'medicine-1', '2026-06-15')).toBe(0);
  });

  it('ignores a schedule that has not started yet', () => {
    const schedule = makeSchedule({ startDate: '2026-07-01' });
    expect(estimateDailyConsumption([schedule], 'medicine-1', '2026-06-15')).toBe(0);
  });

  it('ignores a retired schedule with no end date', () => {
    const schedule = makeSchedule({ active: false });
    expect(estimateDailyConsumption([schedule], 'medicine-1', '2026-06-15')).toBe(0);
  });

  it('includes a closed schedule within its historical window', () => {
    const schedule = makeSchedule({ active: false, endDate: '2026-06-30' });
    expect(estimateDailyConsumption([schedule], 'medicine-1', '2026-06-15')).toBe(1);
  });

  it('excludes a closed schedule past its end date', () => {
    const schedule = makeSchedule({ active: false, endDate: '2026-06-10' });
    expect(estimateDailyConsumption([schedule], 'medicine-1', '2026-06-15')).toBe(0);
  });

  it('is zero for no schedules at all', () => {
    expect(estimateDailyConsumption([], 'medicine-1', '2026-06-15')).toBe(0);
  });
});

describe('daysOfSupply', () => {
  it('divides quantity by daily consumption', () => {
    expect(daysOfSupply(30, 2)).toBe(15);
  });

  it('is null rather than Infinity when nothing is being consumed', () => {
    expect(daysOfSupply(30, 0)).toBeNull();
  });

  it('is null for a negative consumption rate, which should not occur but must not divide oddly', () => {
    expect(daysOfSupply(30, -1)).toBeNull();
  });

  it('is zero, not negative, when already out of stock', () => {
    expect(daysOfSupply(0, 2)).toBe(0);
    expect(daysOfSupply(-3, 2)).toBe(0);
  });
});
