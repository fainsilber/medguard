import { z } from 'zod';
import type { Clock, IsoInstant } from './clock.js';
import {
  intakeLogSchema,
  inventoryAdjustmentSchema,
  inventoryItemSchema,
  isoInstantSchema,
  medicinePatientSchema,
  medicineSchema,
  patientSchema,
  scheduleSchema,
} from './schemas.js';
import { SINGLE_PATIENT_ID, medicinePatientId } from './types.js';
import type {
  IntakeLog,
  InventoryAdjustment,
  InventoryItem,
  Medicine,
  MedicinePatient,
  Patient,
  Schedule,
} from './types.js';

/**
 * A full local backup: patients, medicines, schedules, the complete intake history, and the
 * inventory ledger. Deliberately excludes household settings and anything about identity or
 * devices — this is a medical-data backup, not a device migration tool.
 *
 * The intake log is exported in full, including entries a correction has superseded (safety
 * invariant 1) — a backup that dropped corrected-away entries would silently rewrite history the
 * moment it was restored.
 *
 * Pure: no clock reads except through the injected `Clock`, no I/O. The file-picking and
 * download mechanics live in the web app; this is what decides what a backup *contains*.
 */

export const BACKUP_FORMAT_VERSION = 2;

export const backupBundleSchema = z.object({
  version: z.literal(BACKUP_FORMAT_VERSION),
  exportedAt: isoInstantSchema,
  patients: z.array(patientSchema),
  medicinePatients: z.array(medicinePatientSchema),
  medicines: z.array(medicineSchema),
  schedules: z.array(scheduleSchema),
  intakeLogs: z.array(intakeLogSchema),
  inventoryItems: z.array(inventoryItemSchema),
  inventoryAdjustments: z.array(inventoryAdjustmentSchema),
});

export type BackupBundle = z.infer<typeof backupBundleSchema>;

export interface BackupSource {
  patients: readonly Patient[];
  medicinePatients: readonly MedicinePatient[];
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
    patients: [...source.patients],
    medicinePatients: [...source.medicinePatients],
    medicines: [...source.medicines],
    schedules: [...source.schedules],
    intakeLogs: [...source.intakeLogs],
    inventoryItems: [...source.inventoryItems],
    inventoryAdjustments: [...source.inventoryAdjustments],
  };
}

/** How many of each record a bundle carries — for a caregiver to sanity-check before importing. */
export interface BackupSummary {
  patients: number;
  medicines: number;
  schedules: number;
  intakeLogs: number;
  inventoryItems: number;
  inventoryAdjustments: number;
  exportedAt: IsoInstant;
}

export function summarizeBackup(bundle: BackupBundle): BackupSummary {
  return {
    patients: bundle.patients.length,
    medicines: bundle.medicines.length,
    schedules: bundle.schedules.length,
    intakeLogs: bundle.intakeLogs.length,
    inventoryItems: bundle.inventoryItems.length,
    inventoryAdjustments: bundle.inventoryAdjustments.length,
    exportedAt: bundle.exportedAt,
  };
}

// ---------------------------------------------------------------------------
// Legacy (v1, pre-multi-patient) bundles
// ---------------------------------------------------------------------------

/**
 * The format every backup written before multi-patient support. No `patients` or
 * `medicinePatients` — every medicine simply carried its own `patientId`.
 *
 * Kept only so `parseBackupBundle` can upgrade an old file on restore, per `upgradeLegacyBundle`.
 */
const legacyBackupBundleSchema = z.object({
  version: z.literal(1),
  exportedAt: isoInstantSchema,
  medicines: z.array(medicineSchema),
  schedules: z.array(scheduleSchema),
  intakeLogs: z.array(intakeLogSchema),
  inventoryItems: z.array(inventoryItemSchema),
  inventoryAdjustments: z.array(inventoryAdjustmentSchema),
});

/**
 * Synthesizes `patients` and `medicinePatients` from each medicine's legacy `patientId`, so a
 * backup taken before multi-patient support still restores. A pre-multi-patient app only ever
 * wrote `SINGLE_PATIENT_ID`, so in practice this produces exactly one patient named "Patient" —
 * the same name the server backfill (migration `0005_patients.sql`) gives it — but it's written to
 * handle more than one distinct id defensively rather than assume that.
 */
function upgradeLegacyBundle(legacy: z.infer<typeof legacyBackupBundleSchema>): BackupBundle {
  const patientIds = new Set<string>();
  for (const medicine of legacy.medicines) {
    patientIds.add(medicine.patientId ?? SINGLE_PATIENT_ID);
  }
  if (patientIds.size === 0) {
    patientIds.add(SINGLE_PATIENT_ID);
  }

  const syncStamp = {
    updatedAt: legacy.exportedAt,
    updatedByDeviceId: 'backup-import',
    syncStatus: 'pending' as const,
  };

  const orderedPatientIds = [...patientIds];
  const patients: Patient[] = orderedPatientIds.map((id, index) => ({
    id,
    displayName: id === SINGLE_PATIENT_ID ? 'Patient' : `Patient ${index + 1}`,
    archived: false,
    sortOrder: index,
    ...syncStamp,
  }));

  const medicinePatients: MedicinePatient[] = legacy.medicines.map((medicine) => {
    const patientId = medicine.patientId ?? SINGLE_PATIENT_ID;
    return {
      id: medicinePatientId(medicine.id, patientId),
      medicineId: medicine.id,
      patientId,
      active: true,
      ...syncStamp,
    };
  });

  return {
    version: BACKUP_FORMAT_VERSION,
    exportedAt: legacy.exportedAt,
    patients,
    medicinePatients,
    medicines: legacy.medicines,
    schedules: legacy.schedules,
    intakeLogs: legacy.intakeLogs,
    inventoryItems: legacy.inventoryItems,
    inventoryAdjustments: legacy.inventoryAdjustments,
  };
}

export type ParseBackupResult = { ok: true; bundle: BackupBundle } | { ok: false; error: string };

/**
 * Validates a file's parsed JSON against the backup schema.
 *
 * Every record is re-validated against the same zod schemas the app itself writes with — a
 * hand-edited or corrupted file is rejected before anything reaches IndexedDB, rather than
 * silently storing a medicine with a missing name or a log with an impossible timestamp.
 *
 * A version-1 file is upgraded rather than rejected: `upgradeLegacyBundle` synthesizes the
 * patient roster it never had.
 */
export function parseBackupBundle(input: unknown): ParseBackupResult {
  if (typeof input === 'object' && input !== null && 'version' in input) {
    const version = (input as { version: unknown }).version;

    if (version === 1) {
      const legacyResult = legacyBackupBundleSchema.safeParse(input);
      if (!legacyResult.success) {
        const first = legacyResult.error.issues[0];
        const path = first?.path.join('.') || '(root)';
        return { ok: false, error: `Not a valid MedGuard backup file (${path}: ${first?.message}).` };
      }
      return { ok: true, bundle: upgradeLegacyBundle(legacyResult.data) };
    }

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
