import {
  doseSnoozeSchema,
  householdSettingsSchema,
  intakeLogSchema,
  inventoryAdjustmentSchema,
  inventoryItemSchema,
  medicinePatientSchema,
  medicineSchema,
  patientSchema,
  scheduleSchema,
  shabbatConfigSchema,
  shabbatWindowSchema,
} from '@medguard/shared';
import type { SyncableTable } from '@medguard/shared';
import type { z } from 'zod';

/**
 * What the server knows about each synced table: how to validate it, where to put its columns,
 * and — the part that actually matters — whether it may ever be overwritten.
 *
 * The write rules live here, once, rather than being reimplemented per route. Getting one of them
 * wrong in one place is how a dose goes missing.
 */

/**
 * `lww` — genuinely mutable records (a medicine's name, a schedule, settings). Last write wins,
 * with ties broken deterministically by device id so every device reaches the same answer.
 *
 * `append_only` — intake logs and inventory adjustments. These are **never** updated. A correction
 * appends a new row that supersedes the old one (safety invariant 1), and stock is the sum of
 * immutable deltas (delta D3). A re-sent row is silently accepted as a duplicate rather than
 * applied twice, which is what makes retrying a dropped batch safe: the difference between a
 * resent request and a second dose.
 */
export type WriteRule = 'lww' | 'append_only';

export interface TableConfig {
  table: SyncableTable;
  sqlTable: string;
  writeRule: WriteRule;
  schema: z.ZodType<Record<string, unknown>>;
  /** Maps a validated client record onto the columns the server queries. */
  columns: (record: Record<string, never>) => Record<string, string | number | null>;
}

function bool(value: unknown): number {
  return value ? 1 : 0;
}

function optional(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function optionalNumber(value: unknown): number | null {
  return value === undefined || value === null ? null : Number(value);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- each mapper reads its own validated shape */
export const TABLES: Record<SyncableTable, TableConfig> = {
  householdSettings: {
    table: 'householdSettings',
    sqlTable: 'household_settings',
    writeRule: 'lww',
    schema: householdSettingsSchema as never,
    columns: (r: any) => ({
      time_zone: r.timeZone,
      escalation_after_mins: r.escalationAfterMinutes,
      snooze_mins: r.snoozeMinutes,
    }),
  },

  patients: {
    table: 'patients',
    sqlTable: 'patients',
    writeRule: 'lww',
    schema: patientSchema as never,
    columns: (r: any) => ({
      display_name: r.displayName,
      archived: bool(r.archived),
      sort_order: r.sortOrder,
    }),
  },

  medicinePatients: {
    table: 'medicinePatients',
    sqlTable: 'medicine_patients',
    writeRule: 'lww',
    schema: medicinePatientSchema as never,
    columns: (r: any) => ({
      medicine_id: r.medicineId,
      patient_id: r.patientId,
      active: bool(r.active),
    }),
  },

  medicines: {
    table: 'medicines',
    sqlTable: 'medicines',
    writeRule: 'lww',
    schema: medicineSchema as never,
    columns: (r: any) => ({
      // Vestigial (see the doc comment on `Medicine.patientId` in packages/shared/src/types.ts):
      // who takes a medicine is now `medicinePatients` rows. The column is `NOT NULL`, so an
      // absent field still needs a value; empty string is fine since nothing reads this column.
      patient_id: r.patientId ?? '',
      name: r.name,
      as_needed: bool(r.asNeeded),
      min_hours_between_doses: optionalNumber(r.minHoursBetweenDoses),
      max_daily_doses: optionalNumber(r.maxDailyDoses),
      archived: bool(r.archived),
    }),
  },

  schedules: {
    table: 'schedules',
    sqlTable: 'schedules',
    writeRule: 'lww',
    schema: scheduleSchema as never,
    columns: (r: any) => ({
      medicine_id: r.medicineId,
      patient_id: r.patientId,
      active: bool(r.active),
      start_date: r.startDate,
      end_date: optional(r.endDate),
    }),
  },

  intakeLogs: {
    table: 'intakeLogs',
    sqlTable: 'intake_logs',
    writeRule: 'append_only',
    schema: intakeLogSchema as never,
    columns: (r: any) => ({
      patient_id: r.patientId,
      medicine_id: r.medicineId,
      schedule_id: optional(r.scheduleId),
      type: r.type,
      status: r.status,
      scheduled_time: optional(r.scheduledTime),
      actual_time: r.actualTime,
      quantity_taken: r.quantityTaken,
      logged_by_user_id: r.loggedByUserId,
      logged_by_device_id: r.loggedByDeviceId,
      supersedes_id: optional(r.supersedesId),
      override_reason: optional(r.override?.reason),
      override_blocked_by: optional(r.override?.blockedBy),
      override_confirmed_by: optional(r.override?.confirmedByUserId),
    }),
  },

  inventoryItems: {
    table: 'inventoryItems',
    sqlTable: 'inventory_items',
    writeRule: 'lww',
    schema: inventoryItemSchema as never,
    columns: (r: any) => ({
      medicine_id: r.medicineId,
      refill_threshold: r.refillThreshold,
      unit_name: r.unitName,
    }),
  },

  inventoryAdjustments: {
    table: 'inventoryAdjustments',
    sqlTable: 'inventory_adjustments',
    writeRule: 'append_only',
    schema: inventoryAdjustmentSchema as never,
    columns: (r: any) => ({
      medicine_id: r.medicineId,
      delta: r.delta,
      reason: r.reason,
      related_log_id: optional(r.relatedLogId),
      created_at: r.createdAt,
      created_by_user_id: r.createdByUserId,
      created_by_device_id: r.createdByDeviceId,
    }),
  },

  // Delta AD5. Append-only for the same reason the ledgers above are: concurrent snoozes of the
  // same dose by two caregivers must both survive, and the "at most three" bound is a row count.
  doseSnoozes: {
    table: 'doseSnoozes',
    sqlTable: 'dose_snoozes',
    writeRule: 'append_only',
    schema: doseSnoozeSchema as never,
    columns: (r: any) => ({
      occurrence_id: r.occurrenceId,
      minutes: r.minutes,
      count: r.count,
      created_at: r.createdAt,
      created_by_user_id: r.createdByUserId,
      created_by_device_id: r.createdByDeviceId,
    }),
  },

  shabbatConfig: {
    table: 'shabbatConfig',
    sqlTable: 'shabbat_config',
    writeRule: 'lww',
    schema: shabbatConfigSchema as never,
    columns: (r: any) => ({
      patient_id: r.patientId,
      auto_shabbat_enabled: bool(r.autoShabbatEnabled),
      latitude: r.latitude,
      longitude: r.longitude,
      israel_holidays: bool(r.israelHolidays),
    }),
  },

  /**
   * Sprint A5. The one table the server writes and clients only read (`routes/sync.ts` rejects a
   * client push to it), so `columns` is fed by `shabbat/publish.ts` rather than by an upload.
   */
  shabbatWindows: {
    table: 'shabbatWindows',
    sqlTable: 'shabbat_windows',
    writeRule: 'lww',
    schema: shabbatWindowSchema as never,
    columns: (r: any) => ({
      patient_id: r.patientId,
      starts_at: r.startsAt,
      ends_at: r.endsAt,
    }),
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export const SYNCED_TABLES = Object.keys(TABLES) as SyncableTable[];

/**
 * Append-only tables have no `updatedAt`/`updatedByDeviceId` — they are never overwritten, so
 * there is nothing to resolve. The sync columns still need *something* to store, and the record's
 * own creation instant is the honest answer.
 */
export function syncStampFor(
  config: TableConfig,
  record: Record<string, unknown>,
): { updatedAt: string; updatedByDeviceId: string } {
  if (config.writeRule === 'append_only') {
    return {
      updatedAt: String(record.createdAt ?? record.actualTime ?? ''),
      updatedByDeviceId: String(record.loggedByDeviceId ?? record.createdByDeviceId ?? ''),
    };
  }
  return {
    updatedAt: String(record.updatedAt),
    updatedByDeviceId: String(record.updatedByDeviceId),
  };
}
