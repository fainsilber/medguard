import { describe, expect, it } from 'vitest';
import { fromIso, occurrenceKey, resolveLocal, toIso } from '@medguard/shared';
import type {
  DoseSnooze,
  IntakeLog,
  Medicine,
  Schedule,
  ShabbatConfig,
  ShabbatWindow,
} from '@medguard/shared';
import { ALARM_HORIZON_MS, MAX_ARMED_ALARMS, materializeHorizon } from './horizon.js';

/**
 * The decision that makes the native client worth building: which doses this device arms local
 * alarms for, computed entirely from synced data with no network involved.
 */

const JERUSALEM = 'Asia/Jerusalem';
const NOW = fromIso('2026-06-15T05:00:00.000Z'); // 08:00 Jerusalem

function makeMedicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'medicine-1',
    patientId: 'patient-1',
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    medicineId: 'medicine-1',
    patientId: 'patient-1',
    frequencyType: 'daily',
    timesOfDay: ['12:00'],
    dosageQuantity: 1,
    startDate: '2026-01-01',
    active: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeSnooze(overrides: Partial<DoseSnooze> = {}): DoseSnooze {
  return {
    id: 'snooze-1',
    occurrenceId: 'schedule-1:2026-06-15T09:00:00.000Z',
    minutes: 20,
    count: 1,
    createdAt: '2026-06-15T09:05:00.000Z',
    createdByUserId: 'mom',
    createdByDeviceId: 'device-1',
    syncStatus: 'synced',
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
    actualTime: '2026-06-15T09:00:00.000Z',
    quantityTaken: 1,
    loggedByUserId: 'mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function baseInput(overrides: Partial<Parameters<typeof materializeHorizon>[0]> = {}) {
  return {
    schedules: [makeSchedule()],
    medicines: [makeMedicine()],
    logs: [],
    snoozes: [],
    timeZone: JERUSALEM,
    nowMs: NOW,
    ...overrides,
  };
}

describe('materializeHorizon', () => {
  it('arms each upcoming dose at its due instant', () => {
    const planned = materializeHorizon(baseInput());

    // Daily at 12:00 Jerusalem = 09:00Z in June, so today's and tomorrow's fall inside 48h.
    expect(planned.map((alarm) => toIso(alarm.triggerAtMs))).toEqual([
      '2026-06-15T09:00:00.000Z',
      '2026-06-16T09:00:00.000Z',
    ]);
  });

  it('keys each alarm by occurrenceKey, the same identity the notification is tagged with', () => {
    const [first] = materializeHorizon(baseInput());

    expect(first?.occurrenceKey).toBe(occurrenceKey(first!.occurrence));
    expect(first?.occurrenceKey).toBe('schedule-1:2026-06-15T09:00:00.000Z');
  });

  it('names the medicine and quantity, so a lock screen is enough to act on', () => {
    const [first] = materializeHorizon(
      baseInput({ schedules: [makeSchedule({ dosageQuantity: 2 })] }),
    );

    expect(first?.title).toBe('Ondansetron 4mg is due');
    expect(first?.body).toBe('2 doses · 12:00');
  });

  it('does not arm a dose that already has a log', () => {
    const planned = materializeHorizon(
      baseInput({ logs: [makeLog({ scheduledTime: '2026-06-15T09:00:00.000Z' })] }),
    );

    expect(planned.map((alarm) => toIso(alarm.triggerAtMs))).toEqual(['2026-06-16T09:00:00.000Z']);
  });

  it('follows a correction chain — a dose corrected to skipped stays silent', () => {
    // findLogForOccurrence resolves supersession, so the correction is what counts, not the
    // original. Re-arming a dose a caregiver deliberately marked skipped would be wrong.
    const planned = materializeHorizon(
      baseInput({
        logs: [
          makeLog({ id: 'original', scheduledTime: '2026-06-15T09:00:00.000Z' }),
          makeLog({
            id: 'correction',
            supersedesId: 'original',
            status: 'skipped',
            quantityTaken: 0,
            scheduledTime: '2026-06-15T09:00:00.000Z',
          }),
        ],
      }),
    );

    expect(planned.map((alarm) => alarm.occurrenceKey)).toEqual([
      'schedule-1:2026-06-16T09:00:00.000Z',
    ]);
  });

  it('moves a snoozed dose to its deferral deadline instead of its due time', () => {
    const planned = materializeHorizon(baseInput({ snoozes: [makeSnooze()] }));

    // Snoozed at 09:05Z for 20 minutes.
    expect(toIso(planned[0]!.triggerAtMs)).toBe('2026-06-15T09:25:00.000Z');
  });

  it('re-arms a dose whose due time has passed but whose snooze has not', () => {
    // The case that makes the deferral real: at 09:30 the dose is 30 minutes overdue, and only
    // the snooze deadline keeps it in the horizon at all.
    const planned = materializeHorizon(
      baseInput({
        nowMs: fromIso('2026-06-15T09:10:00.000Z'),
        snoozes: [makeSnooze()],
      }),
    );

    expect(toIso(planned[0]!.triggerAtMs)).toBe('2026-06-15T09:25:00.000Z');
  });

  it('drops a snoozed dose once its deadline has also passed', () => {
    const planned = materializeHorizon(
      baseInput({
        nowMs: fromIso('2026-06-15T09:30:00.000Z'),
        snoozes: [makeSnooze()],
      }),
    );

    // The snoozed dose is gone; the next two days' doses remain, since 48h from 09:30 on the
    // 15th reaches the 17th.
    expect(planned.map((alarm) => alarm.occurrenceKey)).toEqual([
      'schedule-1:2026-06-16T09:00:00.000Z',
      'schedule-1:2026-06-17T09:00:00.000Z',
    ]);
  });

  it('never arms an alarm in the past — a stale alarm firing late is worse than none', () => {
    const planned = materializeHorizon(baseInput({ nowMs: fromIso('2026-06-15T10:00:00.000Z') }));

    for (const alarm of planned) {
      expect(alarm.triggerAtMs).toBeGreaterThan(fromIso('2026-06-15T10:00:00.000Z'));
    }
  });

  it('does not arm doses for an archived medicine', () => {
    expect(materializeHorizon(baseInput({ medicines: [makeMedicine({ archived: true })] }))).toEqual([]);
  });

  it('does not arm doses for a medicine that is missing entirely', () => {
    expect(materializeHorizon(baseInput({ medicines: [] }))).toEqual([]);
  });

  it('does not arm a schedule that has been stopped', () => {
    expect(
      materializeHorizon(baseInput({ schedules: [makeSchedule({ active: false })] })),
    ).toEqual([]);
  });

  it('resolves wall-clock times across a DST boundary rather than assuming a fixed offset', () => {
    // Jerusalem springs forward at 02:00 on 2026-03-27. A dose at 08:00 local is 06:00Z on the
    // 26th and 05:00Z on the 27th — 23 hours apart, not 24. An alarm engine that added a day to
    // the previous instant would fire an hour late on the transition day, every spring.
    const marchNow = fromIso('2026-03-25T12:00:00.000Z');
    const planned = materializeHorizon(
      baseInput({ schedules: [makeSchedule({ timesOfDay: ['08:00'] })], nowMs: marchNow }),
    );

    const expectedFirst = resolveLocal(JERUSALEM, '2026-03-26', '08:00').instantMs;
    const expectedSecond = resolveLocal(JERUSALEM, '2026-03-27', '08:00').instantMs;
    expect(planned.map((alarm) => alarm.triggerAtMs)).toEqual([expectedFirst, expectedSecond]);
    expect(expectedSecond - expectedFirst).toBe(23 * 60 * 60 * 1000);
  });

  it('interleaves an alternating regimen’s two halves in time order', () => {
    const planned = materializeHorizon(
      baseInput({
        schedules: [
          makeSchedule({ id: 'schedule-a', timesOfDay: ['08:00'], regimenGroupId: 'group-1' }),
          makeSchedule({ id: 'schedule-b', timesOfDay: ['20:00'], regimenGroupId: 'group-1' }),
        ],
      }),
    );

    const triggers = planned.map((alarm) => alarm.triggerAtMs);
    expect([...triggers].sort((a, b) => a - b)).toEqual(triggers);
    expect(planned.length).toBeGreaterThan(2);
  });

  it('caps the armed set, keeping the nearest alarms', () => {
    // Many medicines, each hourly: far more occurrences in 48h than the cap allows.
    const schedules = Array.from({ length: 6 }, (_, index) =>
      makeSchedule({
        id: `schedule-${index}`,
        medicineId: `medicine-${index}`,
        timesOfDay: ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00'],
      }),
    );
    const medicines = Array.from({ length: 6 }, (_, index) =>
      makeMedicine({ id: `medicine-${index}` }),
    );

    const planned = materializeHorizon(baseInput({ schedules, medicines }));

    expect(planned).toHaveLength(MAX_ARMED_ALARMS);
    const triggers = planned.map((alarm) => alarm.triggerAtMs);
    expect([...triggers].sort((a, b) => a - b)).toEqual(triggers);
  });

  it('honours a shorter horizon when one is given', () => {
    const planned = materializeHorizon(baseInput({ horizonMs: 12 * 60 * 60 * 1000 }));

    expect(planned).toHaveLength(1);
    expect(toIso(planned[0]!.triggerAtMs)).toBe('2026-06-15T09:00:00.000Z');
  });

  it('defaults to the 48-hour horizon the server also uses', () => {
    const planned = materializeHorizon(baseInput());

    for (const alarm of planned) {
      expect(alarm.triggerAtMs).toBeLessThan(NOW + ALARM_HORIZON_MS);
    }
  });

  it('ignores a snooze whose occurrence key is malformed rather than throwing', () => {
    // Nothing should write one, but a corrupt row must degrade to "no deferral", not take the
    // whole alarm engine down with it.
    const planned = materializeHorizon(
      baseInput({ snoozes: [makeSnooze({ occurrenceId: 'not-a-key' })] }),
    );

    expect(toIso(planned[0]!.triggerAtMs)).toBe('2026-06-15T09:00:00.000Z');
  });

  it('returns nothing when there are no schedules at all', () => {
    expect(materializeHorizon(baseInput({ schedules: [] }))).toEqual([]);
  });
});

/**
 * Sprint A5: which channel a dose rings on.
 *
 * The Shabbat channel posts no action buttons (delta D5) — so getting this wrong does not mean a
 * cosmetically different notification, it means a caregiver being offered a button that writes a
 * record on Shabbat.
 */
describe('materializeHorizon in Shabbat mode', () => {
  // Today's dose is due 2026-06-15T09:00Z. A window around it stands in for whatever the server
  // computed; the real times are `apps/api/tests/zmanim.test.ts`'s business.
  function makeWindow(overrides: Partial<ShabbatWindow> = {}): ShabbatWindow {
    const startsAt = overrides.startsAt ?? '2026-06-15T08:00:00.000Z';
    return {
      id: `shabbat:${startsAt}`,
      patientId: 'patient-1',
      kind: 'shabbat',
      label: 'Shabbat',
      startsAt,
      endsAt: '2026-06-15T20:00:00.000Z',
      generatedAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      updatedByDeviceId: 'server',
      syncStatus: 'synced',
      ...overrides,
    };
  }

  function makeConfig(overrides: Partial<ShabbatConfig> = {}): ShabbatConfig {
    return {
      id: 'shabbat-config-1',
      patientId: 'patient-1',
      autoShabbatEnabled: true,
      latitude: 31.7683,
      longitude: 35.2137,
      candleLightingOffsetMins: 18,
      havdalahDegreesOrMins: '8.5_degrees',
      israelHolidays: true,
      chimeDurationSeconds: 45,
      updatedAt: '2026-06-01T00:00:00.000Z',
      updatedByDeviceId: 'device-1',
      syncStatus: 'synced',
      ...overrides,
    };
  }

  it('arms a weekday dose on the standard channel at the PRD chime length', () => {
    const planned = materializeHorizon(baseInput());

    expect(planned[0]).toMatchObject({
      channelId: 'dose_standard_v1',
      chimeDurationSeconds: 45,
    });
  });

  it('arms a dose inside a window on the Shabbat channel', () => {
    const planned = materializeHorizon(
      baseInput({ shabbatWindows: [makeWindow()], shabbatConfig: makeConfig() }),
    );

    expect(toIso(planned[0]!.triggerAtMs)).toBe('2026-06-15T09:00:00.000Z');
    expect(planned[0]!.channelId).toBe('shabbat_v1');
  });

  it('decides from when the alarm will fire, not from now', () => {
    // Armed now (08:00 Jerusalem, a weekday morning) for a dose that falls after candle lighting.
    // If the decision were made from `nowMs`, this dose would be armed on the weekday channel and
    // ring with action buttons on Shabbat.
    const planned = materializeHorizon(
      baseInput({
        shabbatWindows: [makeWindow({ startsAt: '2026-06-15T08:30:00.000Z' })],
        shabbatConfig: makeConfig(),
      }),
    );

    expect(planned[0]!.channelId).toBe('shabbat_v1');
  });

  it('leaves a dose outside every window on the standard channel', () => {
    const planned = materializeHorizon(
      baseInput({
        shabbatWindows: [
          makeWindow({ startsAt: '2026-06-19T16:00:00.000Z', endsAt: '2026-06-20T17:00:00.000Z' }),
        ],
        shabbatConfig: makeConfig(),
      }),
    );

    expect(planned[0]!.channelId).toBe('dose_standard_v1');
  });

  it('ignores published windows when automation is switched off', () => {
    const planned = materializeHorizon(
      baseInput({
        shabbatWindows: [makeWindow()],
        shabbatConfig: makeConfig({ autoShabbatEnabled: false }),
      }),
    );

    expect(planned[0]!.channelId).toBe('dose_standard_v1');
  });

  it('is weekday behaviour on a device that has never synced a config', () => {
    // The same answer the Durable Object gives from the same inputs — neither guesses.
    const planned = materializeHorizon(baseInput({ shabbatWindows: [makeWindow()] }));

    expect(planned[0]!.channelId).toBe('dose_standard_v1');
  });

  it('takes the chime length from the household configuration', () => {
    const planned = materializeHorizon(
      baseInput({
        shabbatWindows: [makeWindow()],
        shabbatConfig: makeConfig({ chimeDurationSeconds: 90 }),
      }),
    );

    expect(planned[0]!.chimeDurationSeconds).toBe(90);
  });
});
