import { describe, expect, it } from 'vitest';
import { fromIso } from './clock.js';
import {
  activeSchedulesOn,
  closeSchedule,
  expandSchedule,
  expandSchedules,
  occurrenceKey,
  reviseSchedule,
  scheduleAppliesOn,
} from './schedule.js';
import type { ExpansionRange } from './schedule.js';
import { fixedClock, sequentialIds } from './testing.js';
import { formatLocalTime, resolveLocal } from './timezone.js';
import type { LocalDate, Schedule } from './types.js';

const JERUSALEM = 'Asia/Jerusalem';
const DEVICE = 'device-1';

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    medicineId: 'medicine-1',
    patientId: 'patient-1',
    frequencyType: 'daily',
    timesOfDay: ['08:00'],
    dosageQuantity: 1,
    startDate: '2026-01-01',
    active: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: DEVICE,
    syncStatus: 'synced',
    ...overrides,
  };
}

/** The instant range covering one household-local day. */
function dayRange(localDate: LocalDate, days = 1): ExpansionRange {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const endDate = new Date(Date.UTC(y, m - 1, d + days));
  const endLocal = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, '0')}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
  return {
    fromMs: resolveLocal(JERUSALEM, localDate, '00:00').instantMs,
    toMs: resolveLocal(JERUSALEM, endLocal, '00:00').instantMs,
  };
}

function localTimesOf(occurrences: { dueAt: string }[]): string[] {
  return occurrences.map((o) => formatLocalTime(JERUSALEM, fromIso(o.dueAt)));
}

describe('frequency types', () => {
  it('expands a daily schedule once per day', () => {
    const occurrences = expandSchedule(makeSchedule(), dayRange('2026-06-01', 3), JERUSALEM);

    expect(occurrences).toHaveLength(3);
    expect(occurrences.map((o) => o.localDate)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
  });

  it('expands multiple times of day, ordered', () => {
    const schedule = makeSchedule({ timesOfDay: ['20:00', '08:00', '14:00'] });
    const occurrences = expandSchedule(schedule, dayRange('2026-06-01'), JERUSALEM);

    expect(localTimesOf(occurrences)).toEqual(['08:00', '14:00', '20:00']);
  });

  it('expands interval_days from the start date', () => {
    const schedule = makeSchedule({
      frequencyType: 'interval_days',
      intervalDays: 3,
      startDate: '2026-06-01',
    });
    const occurrences = expandSchedule(schedule, dayRange('2026-06-01', 10), JERUSALEM);

    expect(occurrences.map((o) => o.localDate)).toEqual([
      '2026-06-01',
      '2026-06-04',
      '2026-06-07',
      '2026-06-10',
    ]);
  });

  it('keeps interval_days aligned across a month boundary', () => {
    const schedule = makeSchedule({
      frequencyType: 'interval_days',
      intervalDays: 3,
      startDate: '2026-01-28',
    });
    const occurrences = expandSchedule(schedule, dayRange('2026-01-28', 10), JERUSALEM);

    // 31 Jan → 3 Feb is three days, not a reset at the month edge.
    expect(occurrences.map((o) => o.localDate)).toEqual([
      '2026-01-28',
      '2026-01-31',
      '2026-02-03',
      '2026-02-06',
    ]);
  });

  it('expands specific_days by day of week', () => {
    // 2026-06-01 is a Monday.
    const schedule = makeSchedule({
      frequencyType: 'specific_days',
      daysOfWeek: [1, 3, 5],
      startDate: '2026-06-01',
    });
    const occurrences = expandSchedule(schedule, dayRange('2026-06-01', 7), JERUSALEM);

    expect(occurrences.map((o) => o.localDate)).toEqual([
      '2026-06-01',
      '2026-06-03',
      '2026-06-05',
    ]);
  });

  it('produces nothing when interval_days is missing its interval', () => {
    const schedule = makeSchedule({ frequencyType: 'interval_days' });
    expect(expandSchedule(schedule, dayRange('2026-06-01', 10), JERUSALEM)).toEqual([]);
  });

  it('produces nothing when interval_days has a nonsensical interval', () => {
    const schedule = makeSchedule({ frequencyType: 'interval_days', intervalDays: 0 });
    expect(expandSchedule(schedule, dayRange('2026-06-01', 10), JERUSALEM)).toEqual([]);
  });

  it('produces nothing when specific_days is missing its days', () => {
    const schedule = makeSchedule({ frequencyType: 'specific_days' });
    expect(expandSchedule(schedule, dayRange('2026-06-01', 10), JERUSALEM)).toEqual([]);
  });
});

describe('course bounds', () => {
  it('produces nothing before the start date', () => {
    const schedule = makeSchedule({ startDate: '2026-06-05' });
    expect(expandSchedule(schedule, dayRange('2026-06-01', 3), JERUSALEM)).toEqual([]);
  });

  it('includes the start date itself', () => {
    const schedule = makeSchedule({ startDate: '2026-06-05' });
    const occurrences = expandSchedule(schedule, dayRange('2026-06-05'), JERUSALEM);
    expect(occurrences).toHaveLength(1);
  });

  it('includes the end date itself, then stops — a five-day taper gives five doses', () => {
    const schedule = makeSchedule({ startDate: '2026-06-01', endDate: '2026-06-05' });
    const occurrences = expandSchedule(schedule, dayRange('2026-06-01', 10), JERUSALEM);

    expect(occurrences).toHaveLength(5);
    expect(occurrences.at(-1)?.localDate).toBe('2026-06-05');
  });

  it('produces nothing when the end date is already past', () => {
    const schedule = makeSchedule({ startDate: '2026-01-01', endDate: '2026-01-05' });
    expect(expandSchedule(schedule, dayRange('2026-06-01', 3), JERUSALEM)).toEqual([]);
  });
});

describe('DST — a dose is never skipped or doubled', () => {
  it('shifts a dose scheduled inside the spring-forward gap instead of skipping it', () => {
    // 02:30 does not exist on 2026-03-27 in Jerusalem.
    const schedule = makeSchedule({ timesOfDay: ['02:30'] });
    const occurrences = expandSchedule(schedule, dayRange('2026-03-27'), JERUSALEM);

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.dstAdjustment).toBe('shifted_forward');
    expect(formatLocalTime(JERUSALEM, fromIso(occurrences[0]!.dueAt))).toBe('03:30');
    // The configured time is preserved for display, even though it isn't when it fired.
    expect(occurrences[0]?.scheduledLocalTime).toBe('02:30');
  });

  it('emits one dose, not two, when the wall clock repeats an hour', () => {
    // 01:30 happens twice on 2026-10-25 in Jerusalem.
    const schedule = makeSchedule({ timesOfDay: ['01:30'] });
    const occurrences = expandSchedule(schedule, dayRange('2026-10-25'), JERUSALEM);

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.dstAdjustment).toBe('first_of_repeat');
    expect(occurrences[0]?.dueAt).toBe('2026-10-24T22:30:00.000Z');
  });

  it('gives a normal day count across a spring-forward day', () => {
    const occurrences = expandSchedule(makeSchedule(), dayRange('2026-03-26', 3), JERUSALEM);
    expect(occurrences).toHaveLength(3);
  });

  it('gives a normal day count across a fall-back day', () => {
    const occurrences = expandSchedule(makeSchedule(), dayRange('2026-10-24', 3), JERUSALEM);
    expect(occurrences).toHaveLength(3);
  });

  it('leaves dstAdjustment unset on ordinary days', () => {
    const occurrences = expandSchedule(makeSchedule(), dayRange('2026-06-01'), JERUSALEM);
    expect(occurrences[0]?.dstAdjustment).toBeUndefined();
  });
});

describe('range handling', () => {
  it('returns nothing for an empty range', () => {
    const at = resolveLocal(JERUSALEM, '2026-06-01', '00:00').instantMs;
    expect(expandSchedule(makeSchedule(), { fromMs: at, toMs: at }, JERUSALEM)).toEqual([]);
  });

  it('returns nothing for an inverted range', () => {
    const range = dayRange('2026-06-01');
    expect(
      expandSchedule(makeSchedule(), { fromMs: range.toMs, toMs: range.fromMs }, JERUSALEM),
    ).toEqual([]);
  });

  it('is half-open — a dose exactly at toMs belongs to the next range, not this one', () => {
    const schedule = makeSchedule({ timesOfDay: ['00:00'] });
    const first = expandSchedule(schedule, dayRange('2026-06-01'), JERUSALEM);
    const second = expandSchedule(schedule, dayRange('2026-06-02'), JERUSALEM);

    expect(first).toHaveLength(1);
    expect(first[0]?.localDate).toBe('2026-06-01');
    expect(second[0]?.localDate).toBe('2026-06-02');
  });

  it('refuses an absurdly long range rather than hanging', () => {
    const range = dayRange('2026-01-01');
    expect(() =>
      expandSchedule(makeSchedule(), { fromMs: range.fromMs, toMs: range.fromMs + 4000 * 86_400_000 }, JERUSALEM),
    ).toThrow(RangeError);
  });
});

describe('expandSchedules — alternating regimens (delta D6)', () => {
  it('interleaves the two halves of an alternating regimen in time order', () => {
    // 50mg Mon/Wed/Fri, 25mg Tue/Thu/Sat — modelled as two schedules, presented as one.
    const group = 'regimen-1';
    const higher = makeSchedule({
      id: 'schedule-high',
      frequencyType: 'specific_days',
      daysOfWeek: [1, 3, 5],
      dosageQuantity: 50,
      startDate: '2026-06-01',
      regimenGroupId: group,
    });
    const lower = makeSchedule({
      id: 'schedule-low',
      frequencyType: 'specific_days',
      daysOfWeek: [2, 4, 6],
      dosageQuantity: 25,
      startDate: '2026-06-01',
      regimenGroupId: group,
    });

    const occurrences = expandSchedules([lower, higher], dayRange('2026-06-01', 6), JERUSALEM);

    expect(occurrences.map((o) => [o.localDate, o.dosageQuantity])).toEqual([
      ['2026-06-01', 50],
      ['2026-06-02', 25],
      ['2026-06-03', 50],
      ['2026-06-04', 25],
      ['2026-06-05', 50],
      ['2026-06-06', 25],
    ]);
  });

  it('orders deterministically when two schedules collide on the same instant', () => {
    const a = makeSchedule({ id: 'schedule-a' });
    const b = makeSchedule({ id: 'schedule-b' });

    const occurrences = expandSchedules([b, a], dayRange('2026-06-01'), JERUSALEM);
    expect(occurrences.map((o) => o.scheduleId)).toEqual(['schedule-a', 'schedule-b']);
  });

  it('returns nothing for no schedules', () => {
    expect(expandSchedules([], dayRange('2026-06-01'), JERUSALEM)).toEqual([]);
  });
});

describe('versioning — the past is never rewritten', () => {
  const context = {
    clock: fixedClock('2026-06-10T09:00:00.000Z'),
    ids: sequentialIds('schedule'),
    deviceId: DEVICE,
  };

  it('closes the old version the day before the change takes effect', () => {
    const existing = makeSchedule({ startDate: '2026-06-01' });
    const { closed } = reviseSchedule(existing, { dosageQuantity: 2 }, '2026-06-10', context);

    expect(closed.id).toBe(existing.id);
    expect(closed.active).toBe(false);
    expect(closed.endDate).toBe('2026-06-09');
    expect(closed.syncStatus).toBe('pending');
  });

  it('creates the new version starting the day the change takes effect', () => {
    const existing = makeSchedule({ startDate: '2026-06-01', dosageQuantity: 1 });
    const { created } = reviseSchedule(existing, { dosageQuantity: 2 }, '2026-06-10', {
      ...context,
      ids: sequentialIds('new'),
    });

    expect(created.id).not.toBe(existing.id);
    expect(created.supersedesId).toBe(existing.id);
    expect(created.startDate).toBe('2026-06-10');
    expect(created.dosageQuantity).toBe(2);
    expect(created.active).toBe(true);
  });

  it('leaves already-given doses attached to the version that produced them', () => {
    const existing = makeSchedule({ startDate: '2026-06-01', dosageQuantity: 1 });
    const { closed, created } = reviseSchedule(existing, { dosageQuantity: 5 }, '2026-06-10', {
      ...context,
      ids: sequentialIds('new'),
    });

    const before = expandSchedules([closed, created], dayRange('2026-06-05', 3), JERUSALEM);
    const after = expandSchedules([closed, created], dayRange('2026-06-10', 3), JERUSALEM);

    // The historical doses still read 1 — the edit did not rewrite them.
    expect(before.every((o) => o.dosageQuantity === 1)).toBe(true);
    expect(before.every((o) => o.scheduleId === existing.id)).toBe(true);
    // Only the new version applies from the effective date.
    expect(after.every((o) => o.dosageQuantity === 5)).toBe(true);
    expect(after.every((o) => o.scheduleId === created.id)).toBe(true);
  });

  it('never produces a gap or an overlap at the changeover', () => {
    const existing = makeSchedule({ startDate: '2026-06-01' });
    const { closed, created } = reviseSchedule(existing, { dosageQuantity: 2 }, '2026-06-10', {
      ...context,
      ids: sequentialIds('new'),
    });

    const across = expandSchedules([closed, created], dayRange('2026-06-08', 4), JERUSALEM);
    // Exactly one dose per day through the changeover: 8, 9, 10, 11.
    expect(across.map((o) => o.localDate)).toEqual([
      '2026-06-08',
      '2026-06-09',
      '2026-06-10',
      '2026-06-11',
    ]);
  });

  it('retires a version replaced before it ever started, rather than dating it incoherently', () => {
    // Editing a schedule that starts next week: the old version never produced anything, so it
    // must not be given an endDate before its own startDate.
    const existing = makeSchedule({ startDate: '2026-06-20' });
    const { closed, created } = reviseSchedule(existing, { dosageQuantity: 3 }, '2026-06-15', {
      ...context,
      ids: sequentialIds('new'),
    });

    expect(closed.endDate).toBeUndefined();
    expect(closed.active).toBe(false);
    expect(expandSchedule(closed, dayRange('2026-06-01', 60), JERUSALEM)).toEqual([]);
    expect(expandSchedule(created, dayRange('2026-06-20', 2), JERUSALEM)).toHaveLength(2);
  });

  it('does not let a revision inherit the old version endDate', () => {
    const existing = makeSchedule({ startDate: '2026-06-01', endDate: '2026-06-30' });
    const { created } = reviseSchedule(existing, { dosageQuantity: 2 }, '2026-06-10', {
      ...context,
      ids: sequentialIds('new'),
    });

    expect(created.endDate).toBeUndefined();
  });

  it('lets a revision set a new endDate explicitly', () => {
    const existing = makeSchedule({ startDate: '2026-06-01' });
    const { created } = reviseSchedule(existing, { endDate: '2026-06-20' }, '2026-06-10', {
      ...context,
      ids: sequentialIds('new'),
    });

    expect(created.endDate).toBe('2026-06-20');
  });

  it('closeSchedule stops a live schedule without a replacement', () => {
    const existing = makeSchedule({ startDate: '2026-06-01' });
    const closed = closeSchedule(existing, '2026-06-10', {
      clock: context.clock,
      deviceId: DEVICE,
    });

    expect(closed.endDate).toBe('2026-06-09');
    expect(expandSchedule(closed, dayRange('2026-06-10', 5), JERUSALEM)).toEqual([]);
    expect(expandSchedule(closed, dayRange('2026-06-05', 3), JERUSALEM)).toHaveLength(3);
  });
});

describe('scheduleAppliesOn — versioning states', () => {
  it('a live schedule applies', () => {
    expect(scheduleAppliesOn(makeSchedule(), '2026-06-01')).toBe(true);
  });

  it('a closed version still covers its historical window', () => {
    const closed = makeSchedule({ active: false, endDate: '2026-06-30' });
    expect(scheduleAppliesOn(closed, '2026-06-15')).toBe(true);
    expect(scheduleAppliesOn(closed, '2026-07-01')).toBe(false);
  });

  it('a retired version with no end date produces nothing at all', () => {
    const retired = makeSchedule({ active: false });
    expect(scheduleAppliesOn(retired, '2026-06-15')).toBe(false);
  });

  it('a live fixed course is bounded by its end date', () => {
    const course = makeSchedule({ active: true, endDate: '2026-06-05' });
    expect(scheduleAppliesOn(course, '2026-06-05')).toBe(true);
    expect(scheduleAppliesOn(course, '2026-06-06')).toBe(false);
  });
});

describe('activeSchedulesOn', () => {
  it('returns only live schedules covering the date', () => {
    const live = makeSchedule({ id: 'live' });
    const closed = makeSchedule({ id: 'closed', active: false, endDate: '2026-05-31' });
    const future = makeSchedule({ id: 'future', startDate: '2026-07-01' });

    expect(activeSchedulesOn([live, closed, future], '2026-06-15').map((s) => s.id)).toEqual([
      'live',
    ]);
  });
});

describe('occurrenceKey', () => {
  it('is stable and distinguishes schedules at the same instant', () => {
    const [a, b] = expandSchedules(
      [makeSchedule({ id: 'a' }), makeSchedule({ id: 'b' })],
      dayRange('2026-06-01'),
      JERUSALEM,
    );

    expect(occurrenceKey(a!)).not.toBe(occurrenceKey(b!));
    expect(occurrenceKey(a!)).toBe(occurrenceKey(a!));
  });
});
