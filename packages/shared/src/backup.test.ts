import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  buildBackupBundle,
  parseBackupBundle,
  summarizeBackup,
} from './backup.js';
import { fixedClock } from './testing.js';
import { SINGLE_PATIENT_ID } from './types.js';
import type {
  IntakeLog,
  InventoryAdjustment,
  InventoryItem,
  Medicine,
  MedicinePatient,
  Patient,
  Schedule,
} from './types.js';

const NOW = '2026-08-03T12:00:00.000Z';
const MEDICINE_ID = '11111111-1111-4111-8111-111111111111';
const PATIENT_ID = '00000000-0000-4000-8000-000000000001';
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222';
const LOG_ID = '33333333-3333-4333-8333-333333333333';
const LOG_ID_2 = '44444444-4444-4444-8444-444444444444';
const ITEM_ID = '55555555-5555-4555-8555-555555555555';
const ADJUSTMENT_ID = '66666666-6666-4666-8666-666666666666';

function patient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: PATIENT_ID,
    displayName: 'Yoni',
    archived: false,
    sortOrder: 0,
    updatedAt: NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function medicinePatient(overrides: Partial<MedicinePatient> = {}): MedicinePatient {
  return {
    id: `${MEDICINE_ID}:${PATIENT_ID}`,
    medicineId: MEDICINE_ID,
    patientId: PATIENT_ID,
    active: true,
    updatedAt: NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function medicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: MEDICINE_ID,
    patientId: PATIENT_ID,
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: true,
    archived: false,
    updatedAt: NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: SCHEDULE_ID,
    medicineId: MEDICINE_ID,
    patientId: PATIENT_ID,
    frequencyType: 'daily',
    timesOfDay: ['08:00'],
    dosageQuantity: 1,
    startDate: '2026-08-01',
    active: true,
    updatedAt: NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function intakeLog(overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id: LOG_ID,
    patientId: PATIENT_ID,
    medicineId: MEDICINE_ID,
    type: 'prn',
    status: 'taken',
    actualTime: NOW,
    quantityTaken: 1,
    loggedByUserId: 'Mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function inventoryItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: ITEM_ID,
    medicineId: MEDICINE_ID,
    refillThreshold: 5,
    unitName: 'pills',
    updatedAt: NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function inventoryAdjustment(overrides: Partial<InventoryAdjustment> = {}): InventoryAdjustment {
  return {
    id: ADJUSTMENT_ID,
    medicineId: MEDICINE_ID,
    delta: -1,
    reason: 'dose',
    createdAt: NOW,
    createdByUserId: 'Mom',
    createdByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

const FULL_SOURCE = {
  patients: [patient()],
  medicinePatients: [medicinePatient()],
  medicines: [medicine()],
  schedules: [schedule()],
  intakeLogs: [intakeLog(), intakeLog({ id: LOG_ID_2, supersedesId: LOG_ID })],
  inventoryItems: [inventoryItem()],
  inventoryAdjustments: [inventoryAdjustment()],
};

const EMPTY_SOURCE = {
  patients: [],
  medicinePatients: [],
  medicines: [],
  schedules: [],
  intakeLogs: [],
  inventoryItems: [],
  inventoryAdjustments: [],
};

describe('buildBackupBundle', () => {
  it('stamps the export instant from the injected clock, never the ambient clock', () => {
    const bundle = buildBackupBundle(FULL_SOURCE, fixedClock('2026-08-03T09:00:00.000Z'));
    expect(bundle.exportedAt).toBe('2026-08-03T09:00:00.000Z');
  });

  it('carries the format version', () => {
    const bundle = buildBackupBundle(FULL_SOURCE, fixedClock(NOW));
    expect(bundle.version).toBe(BACKUP_FORMAT_VERSION);
  });

  it('includes every record from the source, including a log a correction superseded', () => {
    const bundle = buildBackupBundle(FULL_SOURCE, fixedClock(NOW));

    // The superseded log must survive the round trip — safety invariant 1. A backup that quietly
    // dropped it would rewrite history the moment it was restored.
    expect(bundle.intakeLogs.map((log) => log.id)).toEqual([LOG_ID, LOG_ID_2]);
    expect(bundle.patients).toHaveLength(1);
    expect(bundle.medicinePatients).toHaveLength(1);
    expect(bundle.medicines).toHaveLength(1);
    expect(bundle.schedules).toHaveLength(1);
    expect(bundle.inventoryItems).toHaveLength(1);
    expect(bundle.inventoryAdjustments).toHaveLength(1);
  });

  it('builds an empty-but-valid bundle from an empty household', () => {
    const bundle = buildBackupBundle(EMPTY_SOURCE, fixedClock(NOW));
    expect(parseBackupBundle(bundle)).toMatchObject({ ok: true });
  });
});

describe('parseBackupBundle', () => {
  it('round-trips a bundle built by buildBackupBundle', () => {
    const bundle = buildBackupBundle(FULL_SOURCE, fixedClock(NOW));
    const result = parseBackupBundle(JSON.parse(JSON.stringify(bundle)));

    expect(result).toMatchObject({
      ok: true,
      bundle: {
        patients: [expect.objectContaining({ id: PATIENT_ID })],
        medicines: [expect.objectContaining({ id: MEDICINE_ID })],
      },
    });
  });

  it('rejects a record that fails its own schema, naming the field', () => {
    const bundle = buildBackupBundle(
      { ...FULL_SOURCE, medicines: [medicine({ name: '' })] },
      fixedClock(NOW),
    );
    const result = parseBackupBundle(bundle);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining('medicines.0.name') });
  });

  it('rejects a file from a future, incompatible format version with a clear message', () => {
    const bundle = buildBackupBundle(FULL_SOURCE, fixedClock(NOW));
    const result = parseBackupBundle({ ...bundle, version: 99 });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining('version 99') });
  });

  it('rejects something that is not an object at all', () => {
    for (const input of [null, undefined, 'a string', 42, []]) {
      expect(parseBackupBundle(input).ok).toBe(false);
    }
  });

  it('rejects an object missing every expected field', () => {
    expect(parseBackupBundle({}).ok).toBe(false);
  });

  it('rejects a bundle whose version field is missing entirely', () => {
    const bundle = buildBackupBundle(FULL_SOURCE, fixedClock(NOW));
    const { version: _version, ...withoutVersion } = bundle;
    expect(parseBackupBundle(withoutVersion).ok).toBe(false);
  });

  describe('upgrading a version-1 (pre-multi-patient) bundle', () => {
    const legacyMedicine = {
      id: MEDICINE_ID,
      patientId: PATIENT_ID,
      name: 'Ondansetron',
      strength: '4mg',
      form: 'pill' as const,
      asNeeded: true,
      archived: false,
      updatedAt: NOW,
      updatedByDeviceId: 'device-1',
      syncStatus: 'synced' as const,
    };

    const legacyBundle = {
      version: 1,
      exportedAt: NOW,
      medicines: [legacyMedicine],
      schedules: [schedule()],
      intakeLogs: [intakeLog()],
      inventoryItems: [inventoryItem()],
      inventoryAdjustments: [inventoryAdjustment()],
    };

    it('synthesizes one patient and one medicine assignment from each medicine’s legacy patientId', () => {
      const result = parseBackupBundle(legacyBundle);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.bundle.version).toBe(BACKUP_FORMAT_VERSION);
      expect(result.bundle.patients).toEqual([
        expect.objectContaining({ id: PATIENT_ID, displayName: 'Patient', archived: false }),
      ]);
      expect(result.bundle.medicinePatients).toEqual([
        expect.objectContaining({
          id: `${MEDICINE_ID}:${PATIENT_ID}`,
          medicineId: MEDICINE_ID,
          patientId: PATIENT_ID,
          active: true,
        }),
      ]);
      // Everything else passes through untouched.
      expect(result.bundle.medicines).toEqual([legacyMedicine]);
    });

    it('falls back to SINGLE_PATIENT_ID for a legacy medicine with no patientId at all', () => {
      const { patientId: _patientId, ...withoutPatientId } = legacyMedicine;
      const result = parseBackupBundle({ ...legacyBundle, medicines: [withoutPatientId] });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.bundle.patients).toEqual([
        expect.objectContaining({ id: SINGLE_PATIENT_ID, displayName: 'Patient' }),
      ]);
    });

    it('still rejects a version-1 bundle whose records fail their own schema', () => {
      const result = parseBackupBundle({ ...legacyBundle, medicines: [{ ...legacyMedicine, name: '' }] });
      expect(result.ok).toBe(false);
    });

    it('produces a bundle that round-trips through the current schema', () => {
      const upgraded = parseBackupBundle(legacyBundle);
      expect(upgraded.ok).toBe(true);
      if (!upgraded.ok) return;

      const reparsed = parseBackupBundle(JSON.parse(JSON.stringify(upgraded.bundle)));
      expect(reparsed.ok).toBe(true);
    });
  });
});

describe('summarizeBackup', () => {
  it('counts every record type for a caregiver to sanity-check before importing', () => {
    const bundle = buildBackupBundle(FULL_SOURCE, fixedClock(NOW));
    expect(summarizeBackup(bundle)).toEqual({
      patients: 1,
      medicines: 1,
      schedules: 1,
      intakeLogs: 2,
      inventoryItems: 1,
      inventoryAdjustments: 1,
      exportedAt: NOW,
    });
  });
});
