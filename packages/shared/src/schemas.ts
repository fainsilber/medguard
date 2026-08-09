import { z } from 'zod';

import { parseOccurrenceKey } from './schedule.js';

/**
 * Runtime validation for everything that crosses a trust boundary: user input, IndexedDB reads
 * after a schema migration, and (from Sprint 3) request bodies on the Worker.
 *
 * Shared rather than duplicated per side, so the client and the authoritative server can never
 * disagree about what a valid dose looks like — the same failure mode delta D2 guards against
 * for cooldowns.
 */

/** ISO 8601, UTC, milliseconds — the canonical storage format produced by `toIso`. */
export const isoInstantSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'Must be ISO-8601 UTC with milliseconds')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Not a real instant');

/** `YYYY-MM-DD`, and a date that actually exists — rejects 2026-02-30. */
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
  .refine((value) => {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const probe = new Date(Date.UTC(y, m - 1, d));
    return (
      probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
    );
  }, 'Not a real calendar date');

/** `HH:MM`, 24-hour. */
export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM (24-hour)');

export const syncStatusSchema = z.enum(['synced', 'pending']);

const syncableFields = {
  updatedAt: isoInstantSchema,
  updatedByDeviceId: z.string().min(1),
  syncStatus: syncStatusSchema,
};

// ---------------------------------------------------------------------------

export const householdSettingsSchema = z.object({
  id: z.literal('household'),
  timeZone: z
    .string()
    .min(1)
    // Rejects a zone this runtime can't actually resolve, rather than failing later inside a
    // dose calculation where the error would be far from its cause.
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, 'Not a recognised IANA time zone'),
  escalationAfterMinutes: z.number().int().positive(),
  snoozeMinutes: z.number().int().positive(),
  ...syncableFields,
});

export const medicineFormSchema = z.enum(['pill', 'liquid', 'injection', 'topical', 'other']);

export const medicineSchema = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  name: z.string().min(1).max(200),
  strength: z.string().min(1).max(100),
  form: medicineFormSchema,
  asNeeded: z.boolean(),
  // Positive, not just non-negative: a zero-hour cooldown is indistinguishable from "no cooldown"
  // but reads as if a limit exists. Omit the field instead.
  minHoursBetweenDoses: z.number().positive().max(24 * 7).optional(),
  maxDailyDoses: z.number().int().positive().max(100).optional(),
  instructions: z.string().max(2000).optional(),
  archived: z.boolean(),
  ...syncableFields,
});

export const frequencyTypeSchema = z.enum(['daily', 'interval_days', 'specific_days']);

export const scheduleSchema = z
  .object({
    id: z.uuid(),
    medicineId: z.uuid(),
    patientId: z.uuid(),
    frequencyType: frequencyTypeSchema,
    intervalDays: z.number().int().min(1).max(365).optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    timesOfDay: z.array(localTimeSchema).min(1).max(24),
    dosageQuantity: z.number().positive(),
    startDate: localDateSchema,
    endDate: localDateSchema.optional(),
    active: z.boolean(),
    regimenGroupId: z.uuid().optional(),
    supersedesId: z.uuid().optional(),
    ...syncableFields,
  })
  .superRefine((schedule, ctx) => {
    // The discriminating field has to actually carry its parameter, or expansion silently
    // produces no occurrences — a schedule that looks configured but never fires.
    if (schedule.frequencyType === 'interval_days' && schedule.intervalDays === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['intervalDays'],
        message: 'intervalDays is required when frequencyType is interval_days',
      });
    }
    if (schedule.frequencyType === 'specific_days' && schedule.daysOfWeek === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['daysOfWeek'],
        message: 'daysOfWeek is required when frequencyType is specific_days',
      });
    }
    if (schedule.endDate !== undefined && schedule.endDate < schedule.startDate) {
      ctx.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'endDate cannot be before startDate',
      });
    }
    if (schedule.daysOfWeek && new Set(schedule.daysOfWeek).size !== schedule.daysOfWeek.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['daysOfWeek'],
        message: 'daysOfWeek cannot repeat a day',
      });
    }
    if (new Set(schedule.timesOfDay).size !== schedule.timesOfDay.length) {
      // Two identical times would expand to two occurrences at the same instant — read by a
      // caregiver as one dose, but satisfied twice.
      ctx.addIssue({
        code: 'custom',
        path: ['timesOfDay'],
        message: 'timesOfDay cannot repeat a time',
      });
    }
  });

export const intakeTypeSchema = z.enum(['scheduled', 'prn']);
export const intakeStatusSchema = z.enum(['taken', 'skipped', 'missed', 'pending_shabbat']);

export const doseOverrideSchema = z.object({
  confirmedByUserId: z.string().min(1),
  // Non-empty by construction: an override with a blank reason defeats the audit trail it exists
  // to create (safety invariant 5).
  reason: z.string().min(1).max(2000),
  blockedBy: z.enum(['cooldown', 'daily_cap', 'untrusted_clock']),
});

export const intakeLogSchema = z
  .object({
    id: z.uuid(),
    patientId: z.uuid(),
    medicineId: z.uuid(),
    scheduleId: z.uuid().optional(),
    type: intakeTypeSchema,
    status: intakeStatusSchema,
    scheduledTime: isoInstantSchema.optional(),
    actualTime: isoInstantSchema,
    quantityTaken: z.number().nonnegative(),
    loggedByUserId: z.string().min(1),
    loggedByDeviceId: z.string().min(1),
    notes: z.string().max(2000).optional(),
    override: doseOverrideSchema.optional(),
    supersedesId: z.uuid().optional(),
    syncStatus: syncStatusSchema,
  })
  .superRefine((log, ctx) => {
    if (log.type === 'scheduled' && log.scheduleId === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['scheduleId'],
        message: 'scheduleId is required for a scheduled intake',
      });
    }
    if (log.status === 'taken' && log.quantityTaken <= 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['quantityTaken'],
        message: 'A dose recorded as taken must have a positive quantity',
      });
    }
    if (log.supersedesId === log.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['supersedesId'],
        message: 'A log cannot supersede itself',
      });
    }
  });

export const inventoryAdjustmentReasonSchema = z.enum([
  'initial',
  'dose',
  'refill',
  'correction',
  'lost',
]);

export const inventoryAdjustmentSchema = z
  .object({
    id: z.uuid(),
    medicineId: z.uuid(),
    // Explicitly excludes zero: a no-op ledger row is noise that still costs a sync round trip.
    delta: z.number().refine((value) => value !== 0, 'delta cannot be zero'),
    reason: inventoryAdjustmentReasonSchema,
    relatedLogId: z.uuid().optional(),
    createdAt: isoInstantSchema,
    createdByUserId: z.string().min(1),
    createdByDeviceId: z.string().min(1),
    note: z.string().max(2000).optional(),
    syncStatus: syncStatusSchema,
  })
  .superRefine((adjustment, ctx) => {
    if (adjustment.reason === 'dose' && adjustment.delta > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['delta'],
        message: 'A dose consumes stock, so its delta must be negative',
      });
    }
    if (adjustment.reason === 'refill' && adjustment.delta < 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['delta'],
        message: 'A refill adds stock, so its delta must be positive',
      });
    }
  });

export const inventoryItemSchema = z.object({
  id: z.uuid(),
  medicineId: z.uuid(),
  refillThreshold: z.number().nonnegative(),
  unitName: z.string().min(1).max(50),
  lastRefilledAt: isoInstantSchema.optional(),
  ...syncableFields,
});

/**
 * An `occurrenceKey` — validated by running it back through the one parser rather than by a
 * second regex that could drift from how `occurrenceKey()` composes it.
 */
export const occurrenceKeySchema = z
  .string()
  .min(1)
  .refine((value) => parseOccurrenceKey(value) !== undefined, 'Not a valid occurrence key');

export const doseSnoozeSchema = z.object({
  id: z.uuid(),
  occurrenceId: occurrenceKeySchema,
  minutes: z.number().int().positive().max(1440),
  // 1-based, and bounded well above MAX_SNOOZE_COUNT rather than at it: the bound is a client
  // policy the server does not enforce, and a record that already exists must still validate if
  // that policy is ever loosened.
  count: z.number().int().positive(),
  createdAt: isoInstantSchema,
  createdByUserId: z.string().min(1),
  createdByDeviceId: z.string().min(1),
  syncStatus: syncStatusSchema,
});

export const shabbatConfigSchema = z.object({
  id: z.uuid(),
  patientId: z.uuid(),
  autoShabbatEnabled: z.boolean(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  candleLightingOffsetMins: z.number().int().min(0).max(120),
  havdalahDegreesOrMins: z.string().regex(/^\d+(\.\d+)?_(degrees|mins)$/, 'e.g. 8.5_degrees or 50_mins'),
  israelHolidays: z.boolean(),
  chimeDurationSeconds: z.number().int().positive().max(600),
  ...syncableFields,
});

export const syncableTableSchema = z.enum([
  'medicines',
  'schedules',
  'intakeLogs',
  'inventoryItems',
  'inventoryAdjustments',
  'doseSnoozes',
  'shabbatConfig',
  'householdSettings',
]);

export const syncActionSchema = z.enum(['CREATE', 'UPDATE', 'DELETE']);

export const syncOutboxEntrySchema = z.object({
  id: z.number().int().optional(),
  table: syncableTableSchema,
  entityId: z.string().min(1),
  action: syncActionSchema,
  payload: z.unknown(),
  createdAt: isoInstantSchema,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  lastAttemptAt: isoInstantSchema.optional(),
});
