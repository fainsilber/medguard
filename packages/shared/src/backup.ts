import { z } from 'zod';
import type { Clock, IsoInstant } from './clock.js';
import {
  intakeLogSchema,
  inventoryAdjustmentSchema,
  inventoryItemSchema,
  isoInstantSchema,
  medicineSchema,
  scheduleSchema,
} from './schemas.js';
import type { IntakeLog, InventoryAdjustment, InventoryItem, Medicine, Schedule } from './types.js';

/**
 * A full local backup: medicines, schedules, the complete intake history, and the inventory
 * ledger. Deliberately excludes household settings and anything about identity or devices — this
 * is a medical-data backup, not a device migration tool.
 *
 * The intake log is exported in full, including entries a correction has superseded (safety
 * invariant 1) — a backup that dropped corrected-away entries would silently rewrite history the
 * moment it was restored.
 *
 * Pure: no clock reads except through the injected `Clock`, no I/O. The file-picking and
 * download mechanics live in the web app; this is what decides what a backup *contains*.
 */

export const BACKUP_FORMAT_VERSION = 1;

export const backupBundleSchema = z.object({
  version: z.literal(BACKUP_FORMAT_VERSION),
  exportedAt: isoInstantSchema,
  medicines: z.array(medicineSchema),
  schedules: z.array(scheduleSchema),
  intakeLogs: z.array(intakeLogSchema),
  inventoryItems: z.array(inventoryItemSchema),
  inventoryAdjustments: z.array(inventoryAdjustmentSchema),
});

export type BackupBundle = z.infer<typeof backupBundleSchema>;

export interface BackupSource {
  medicines: readonly Medicine[];
  schedules: readonly Schedule[];
  intakeLogs: readonly IntakeLog[];
  inventoryItems: readonly InventoryItem[];
  inventoryAdjustments: readonly InventoryAdjustment[];
}

export function buildBackupBundle(source: BackupSource, clock: Clock): BackupBundle {
  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: clock.nowIso(),
    medicines: [...source.medicines],
    schedules: [...source.schedules],
    intakeLogs: [...source.intakeLogs],
    inventoryItems: [...source.inventoryItems],
    inventoryAdjustments: [...source.inventoryAdjustments],
  };
}

/** How many of each record a bundle carries — for a caregiver to sanity-check before importing. */
export interface BackupSummary {
  medicines: number;
  schedules: number;
  intakeLogs: number;
  inventoryItems: number;
  inventoryAdjustments: number;
  exportedAt: IsoInstant;
}

export function summarizeBackup(bundle: BackupBundle): BackupSummary {
  return {
    medicines: bundle.medicines.length,
    schedules: bundle.schedules.length,
    intakeLogs: bundle.intakeLogs.length,
    inventoryItems: bundle.inventoryItems.length,
    inventoryAdjustments: bundle.inventoryAdjustments.length,
    exportedAt: bundle.exportedAt,
  };
}

export type ParseBackupResult = { ok: true; bundle: BackupBundle } | { ok: false; error: string };

/**
 * Validates a file's parsed JSON against the backup schema.
 *
 * Every record is re-validated against the same zod schemas the app itself writes with — a
 * hand-edited or corrupted file is rejected before anything reaches IndexedDB, rather than
 * silently storing a medicine with a missing name or a log with an impossible timestamp.
 */
export function parseBackupBundle(input: unknown): ParseBackupResult {
  if (typeof input === 'object' && input !== null && 'version' in input) {
    const version = (input as { version: unknown }).version;
    if (version !== BACKUP_FORMAT_VERSION) {
      return {
        ok: false,
        error: `This file is backup format version ${String(version)}, but this app reads version ${BACKUP_FORMAT_VERSION}.`,
      };
    }
  }

  const result = backupBundleSchema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') || '(root)';
    return { ok: false, error: `Not a valid MedGuard backup file (${path}: ${first?.message}).` };
  }

  return { ok: true, bundle: result.data };
}
