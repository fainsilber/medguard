import { describe, expect, it } from 'vitest';
import type { IntakeLog } from './types.js';
import type { Occurrence } from './schedule.js';
import { findLogForOccurrence } from './matchOccurrenceLog.js';

function makeOccurrence(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    scheduleId: 'schedule-1',
    medicineId: 'medicine-1',
    patientId: 'patient-1',
    dueAt: '2026-06-15T08:00:00.000Z',
    localDate: '2026-06-15',
    scheduledLocalTime: '08:00',
    dosageQuantity: 1,
    ...overrides,
  };
}

function makeLog(overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id: 'log-1',
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    scheduleId: 'schedule-1',
    type: 'scheduled',
    status: 'taken',
    scheduledTime: '2026-06-15T08:00:00.000Z',
    actualTime: '2026-06-15T08:00:00.000Z',
    quantityTaken: 1,
    loggedByUserId: 'Mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('findLogForOccurrence', () => {
  it('finds a log matching schedule and scheduled time', () => {
    const log = makeLog();
    expect(findLogForOccurrence([log], makeOccurrence())?.id).toBe('log-1');
  });

  it('matches even when logged well after the actual due time (late or Shabbat reconciliation)', () => {
    const log = makeLog({ actualTime: '2026-06-15T23:00:00.000Z' });
    expect(findLogForOccurrence([log], makeOccurrence())?.id).toBe('log-1');
  });

  it('does not match a log for a different schedule', () => {
    const log = makeLog({ scheduleId: 'other-schedule' });
    expect(findLogForOccurrence([log], makeOccurrence())).toBeUndefined();
  });

  it('does not match a log for a different occurrence of the same schedule', () => {
    const log = makeLog({ scheduledTime: '2026-06-15T20:00:00.000Z' });
    expect(findLogForOccurrence([log], makeOccurrence())).toBeUndefined();
  });

  it('ignores a log that a later correction superseded', () => {
    const original = makeLog({ id: 'original' });
    const correction = makeLog({
      id: 'correction',
      supersedesId: 'original',
      status: 'skipped',
      scheduledTime: '2026-06-15T20:00:00.000Z',
    });
    // The correction moved to a different scheduled time — the original occurrence should show
    // as unlogged now, not still matched to the superseded log.
    expect(findLogForOccurrence([original, correction], makeOccurrence())).toBeUndefined();
  });

  it('finds the correction, not the original, when both answer the same occurrence', () => {
    const original = makeLog({ id: 'original', status: 'skipped' });
    const correction = makeLog({ id: 'correction', supersedesId: 'original', status: 'taken' });
    expect(findLogForOccurrence([original, correction], makeOccurrence())?.id).toBe('correction');
  });

  it('is undefined for no matching logs', () => {
    expect(findLogForOccurrence([], makeOccurrence())).toBeUndefined();
  });
});
