import { describe, expect, it } from 'vitest';
import type { Schedule } from './types.js';
import { describeSchedule } from './scheduleDisplay.js';

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

describe('describeSchedule', () => {
  it('describes a daily schedule', () => {
    expect(describeSchedule(makeSchedule())).toBe('Every day at 08:00 — 1');
  });

  it('lists every time of day', () => {
    const schedule = makeSchedule({ timesOfDay: ['08:00', '20:00'] });
    expect(describeSchedule(schedule)).toBe('Every day at 08:00, 20:00 — 1');
  });

  it('describes an interval schedule', () => {
    const schedule = makeSchedule({ frequencyType: 'interval_days', intervalDays: 3 });
    expect(describeSchedule(schedule)).toBe('Every 3 days at 08:00 — 1');
  });

  it('describes a specific-days schedule with day labels', () => {
    const schedule = makeSchedule({ frequencyType: 'specific_days', daysOfWeek: [1, 3, 5] });
    expect(describeSchedule(schedule)).toBe('Mon/Wed/Fri at 08:00 — 1');
  });

  it('shows the dosage quantity, including fractional doses', () => {
    const schedule = makeSchedule({ dosageQuantity: 0.5 });
    expect(describeSchedule(schedule)).toBe('Every day at 08:00 — 0.5');
  });

  it('degrades gracefully for an interval schedule missing its interval', () => {
    const schedule = makeSchedule({ frequencyType: 'interval_days' });
    expect(describeSchedule(schedule)).toBe('Every ? days at 08:00 — 1');
  });

  it('degrades gracefully for a specific-days schedule with no days selected', () => {
    const schedule = makeSchedule({ frequencyType: 'specific_days', daysOfWeek: [] });
    expect(describeSchedule(schedule)).toBe('No days selected at 08:00 — 1');
  });
});
