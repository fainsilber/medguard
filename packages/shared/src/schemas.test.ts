import { describe, expect, it } from 'vitest';
import {
  doseSnoozeSchema,
  householdSettingsSchema,
  intakeLogSchema,
  inventoryAdjustmentSchema,
  isoInstantSchema,
  localDateSchema,
  localTimeSchema,
  medicineSchema,
  scheduleSchema,
  shabbatConfigSchema,
} from './schemas.js';

const UUID = '3f1a8c4e-9b2d-4c7a-8e5f-1a2b3c4d5e6f';
const UUID_2 = '7d9e2f1a-3b4c-4d5e-9f8a-2b3c4d5e6f7a';
const NOW = '2026-06-15T12:00:00.000Z';

const syncable = { updatedAt: NOW, updatedByDeviceId: 'device-1', syncStatus: 'synced' } as const;

describe('isoInstantSchema', () => {
  it('accepts the canonical storage format', () => {
    expect(isoInstantSchema.safeParse(NOW).success).toBe(true);
  });

  it('rejects a non-UTC offset — storage is normalised to UTC', () => {
    expect(isoInstantSchema.safeParse('2026-06-15T12:00:00.000+03:00').success).toBe(false);
  });

  it('rejects second-precision without milliseconds', () => {
    expect(isoInstantSchema.safeParse('2026-06-15T12:00:00Z').success).toBe(false);
  });

  it('rejects a well-formed but impossible instant', () => {
    expect(isoInstantSchema.safeParse('2026-13-45T99:99:99.999Z').success).toBe(false);
  });
});

describe('localDateSchema', () => {
  it('accepts a real date', () => {
    expect(localDateSchema.safeParse('2026-06-15').success).toBe(true);
  });

  it('accepts a leap day in a leap year', () => {
    expect(localDateSchema.safeParse('2028-02-29').success).toBe(true);
  });

  it('rejects 29 February in a non-leap year', () => {
    expect(localDateSchema.safeParse('2026-02-29').success).toBe(false);
  });

  it('rejects a day that does not exist in its month', () => {
    expect(localDateSchema.safeParse('2026-04-31').success).toBe(false);
  });

  it('rejects an instant where a date is expected', () => {
    expect(localDateSchema.safeParse(NOW).success).toBe(false);
  });
});

describe('localTimeSchema', () => {
  it('accepts a 24-hour time', () => {
    expect(localTimeSchema.safeParse('08:00').success).toBe(true);
    expect(localTimeSchema.safeParse('23:59').success).toBe(true);
  });

  it('rejects an out-of-range hour or minute', () => {
    expect(localTimeSchema.safeParse('24:00').success).toBe(false);
    expect(localTimeSchema.safeParse('12:60').success).toBe(false);
  });

  it('rejects an unpadded time', () => {
    expect(localTimeSchema.safeParse('8:00').success).toBe(false);
  });
});

describe('householdSettingsSchema', () => {
  const valid = {
    id: 'household',
    timeZone: 'Asia/Jerusalem',
    escalationAfterMinutes: 15,
    snoozeMinutes: 15,
    ...syncable,
  };

  it('accepts a real IANA zone', () => {
    expect(householdSettingsSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a timezone this runtime cannot resolve', () => {
    // Caught here rather than surfacing later inside a dose calculation, far from its cause.
    expect(householdSettingsSchema.safeParse({ ...valid, timeZone: 'Mars/Olympus' }).success).toBe(
      false,
    );
  });
});

describe('medicineSchema', () => {
  const valid = {
    id: UUID,
    patientId: UUID_2,
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    ...syncable,
  };

  it('accepts a minimal medicine with no guards', () => {
    expect(medicineSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts configured safety guards', () => {
    const result = medicineSchema.safeParse({
      ...valid,
      minHoursBetweenDoses: 4,
      maxDailyDoses: 4,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a zero-hour cooldown, which reads as a limit but is not one', () => {
    expect(medicineSchema.safeParse({ ...valid, minHoursBetweenDoses: 0 }).success).toBe(false);
  });

  it('rejects a zero or fractional daily cap', () => {
    expect(medicineSchema.safeParse({ ...valid, maxDailyDoses: 0 }).success).toBe(false);
    expect(medicineSchema.safeParse({ ...valid, maxDailyDoses: 2.5 }).success).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(medicineSchema.safeParse({ ...valid, name: '' }).success).toBe(false);
  });
});

describe('scheduleSchema', () => {
  const valid = {
    id: UUID,
    medicineId: UUID_2,
    patientId: UUID_2,
    frequencyType: 'daily',
    timesOfDay: ['08:00', '20:00'],
    dosageQuantity: 1,
    startDate: '2026-06-01',
    active: true,
    ...syncable,
  };

  it('accepts a daily schedule', () => {
    expect(scheduleSchema.safeParse(valid).success).toBe(true);
  });

  it('requires an interval when the frequency is interval_days', () => {
    // Without it, expansion silently produces nothing — a schedule that looks configured but
    // never fires.
    const result = scheduleSchema.safeParse({ ...valid, frequencyType: 'interval_days' });
    expect(result.success).toBe(false);
  });

  it('accepts interval_days with its interval', () => {
    const result = scheduleSchema.safeParse({
      ...valid,
      frequencyType: 'interval_days',
      intervalDays: 3,
    });
    expect(result.success).toBe(true);
  });

  it('requires days when the frequency is specific_days', () => {
    expect(scheduleSchema.safeParse({ ...valid, frequencyType: 'specific_days' }).success).toBe(
      false,
    );
  });

  it('rejects an end date before the start date', () => {
    const result = scheduleSchema.safeParse({ ...valid, endDate: '2026-05-01' });
    expect(result.success).toBe(false);
  });

  it('accepts an end date on the start date — a single-day course', () => {
    expect(scheduleSchema.safeParse({ ...valid, endDate: '2026-06-01' }).success).toBe(true);
  });

  it('rejects a repeated day of week', () => {
    const result = scheduleSchema.safeParse({
      ...valid,
      frequencyType: 'specific_days',
      daysOfWeek: [1, 1, 3],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a repeated time of day, which would double a dose', () => {
    expect(scheduleSchema.safeParse({ ...valid, timesOfDay: ['08:00', '08:00'] }).success).toBe(
      false,
    );
  });

  it('rejects an empty times list', () => {
    expect(scheduleSchema.safeParse({ ...valid, timesOfDay: [] }).success).toBe(false);
  });
});

describe('intakeLogSchema', () => {
  const valid = {
    id: UUID,
    patientId: UUID_2,
    medicineId: UUID_2,
    type: 'prn',
    status: 'taken',
    actualTime: NOW,
    quantityTaken: 1,
    loggedByUserId: 'mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'synced',
  };

  it('accepts a PRN dose', () => {
    expect(intakeLogSchema.safeParse(valid).success).toBe(true);
  });

  it('requires a schedule id for a scheduled dose', () => {
    const result = intakeLogSchema.safeParse({ ...valid, type: 'scheduled' });
    expect(result.success).toBe(false);
  });

  it('rejects a dose recorded as taken with no quantity', () => {
    expect(intakeLogSchema.safeParse({ ...valid, quantityTaken: 0 }).success).toBe(false);
  });

  it('accepts a zero quantity for a skipped dose', () => {
    const result = intakeLogSchema.safeParse({ ...valid, status: 'skipped', quantityTaken: 0 });
    expect(result.success).toBe(true);
  });

  it('rejects a log that supersedes itself', () => {
    expect(intakeLogSchema.safeParse({ ...valid, supersedesId: UUID }).success).toBe(false);
  });

  it('requires a non-empty reason on an override', () => {
    // A blank reason defeats the audit trail the override exists to create.
    const result = intakeLogSchema.safeParse({
      ...valid,
      override: { confirmedByUserId: 'mom', reason: '', blockedBy: 'cooldown' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a properly attributed override', () => {
    const result = intakeLogSchema.safeParse({
      ...valid,
      override: {
        confirmedByUserId: 'mom',
        reason: 'Vomiting, dose not retained',
        blockedBy: 'cooldown',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('inventoryAdjustmentSchema', () => {
  const valid = {
    id: UUID,
    medicineId: UUID_2,
    delta: -1,
    reason: 'dose',
    createdAt: NOW,
    createdByUserId: 'mom',
    createdByDeviceId: 'device-1',
    syncStatus: 'synced',
  };

  it('accepts a dose decrement', () => {
    expect(inventoryAdjustmentSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a zero delta — a no-op row that still costs a sync round trip', () => {
    expect(inventoryAdjustmentSchema.safeParse({ ...valid, delta: 0 }).success).toBe(false);
  });

  it('rejects a dose that would add stock', () => {
    expect(inventoryAdjustmentSchema.safeParse({ ...valid, delta: 1 }).success).toBe(false);
  });

  it('rejects a refill that would remove stock', () => {
    const result = inventoryAdjustmentSchema.safeParse({ ...valid, reason: 'refill', delta: -5 });
    expect(result.success).toBe(false);
  });

  it('accepts a correction in either direction', () => {
    expect(
      inventoryAdjustmentSchema.safeParse({ ...valid, reason: 'correction', delta: 2 }).success,
    ).toBe(true);
    expect(
      inventoryAdjustmentSchema.safeParse({ ...valid, reason: 'correction', delta: -2 }).success,
    ).toBe(true);
  });
});

describe('doseSnoozeSchema', () => {
  const valid = {
    id: UUID,
    occurrenceId: `${UUID_2}:${NOW}`,
    minutes: 20,
    count: 1,
    createdAt: NOW,
    createdByUserId: 'mom',
    createdByDeviceId: 'device-1',
    syncStatus: 'synced',
  };

  it('accepts a snooze', () => {
    expect(doseSnoozeSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an occurrence id that is not a real occurrence key', () => {
    // The occurrence id is the join back to a dose. A malformed one would validate, sync, and
    // then silently defer nothing — the alarm would keep ringing with a snooze on record.
    expect(doseSnoozeSchema.safeParse({ ...valid, occurrenceId: UUID_2 }).success).toBe(false);
    expect(
      doseSnoozeSchema.safeParse({ ...valid, occurrenceId: `${UUID_2}:not-an-instant` }).success,
    ).toBe(false);
  });

  it('rejects a zero or negative ordinal — the count is 1-based', () => {
    expect(doseSnoozeSchema.safeParse({ ...valid, count: 0 }).success).toBe(false);
  });

  it('accepts a count above MAX_SNOOZE_COUNT, which is a client policy the server does not enforce', () => {
    expect(doseSnoozeSchema.safeParse({ ...valid, count: 9 }).success).toBe(true);
  });

  it('rejects a non-positive or absurd duration', () => {
    expect(doseSnoozeSchema.safeParse({ ...valid, minutes: 0 }).success).toBe(false);
    expect(doseSnoozeSchema.safeParse({ ...valid, minutes: 1441 }).success).toBe(false);
  });
});

describe('shabbatConfigSchema', () => {
  const valid = {
    id: UUID,
    patientId: UUID_2,
    autoShabbatEnabled: true,
    latitude: 31.7683,
    longitude: 35.2137,
    candleLightingOffsetMins: 18,
    havdalahDegreesOrMins: '8.5_degrees',
    israelHolidays: true,
    chimeDurationSeconds: 30,
    weekdayChimeDurationSeconds: 60,
    ...syncable,
  };

  it('accepts a Jerusalem configuration', () => {
    expect(shabbatConfigSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a minutes-based havdalah', () => {
    expect(
      shabbatConfigSchema.safeParse({ ...valid, havdalahDegreesOrMins: '50_mins' }).success,
    ).toBe(true);
  });

  it('rejects an unparseable havdalah setting', () => {
    expect(shabbatConfigSchema.safeParse({ ...valid, havdalahDegreesOrMins: 'soon' }).success).toBe(
      false,
    );
  });

  it('rejects impossible coordinates', () => {
    expect(shabbatConfigSchema.safeParse({ ...valid, latitude: 91 }).success).toBe(false);
  });

  it('requires the Israel/diaspora flag (delta D4)', () => {
    const { israelHolidays: _omitted, ...withoutFlag } = valid;
    expect(shabbatConfigSchema.safeParse(withoutFlag).success).toBe(false);
  });
});
