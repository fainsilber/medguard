import type {
  DoseSnooze,
  IntakeLog,
  InventoryAdjustment,
  InventoryItem,
  Medicine,
  MedicinePatient,
  Patient,
  Schedule,
  ShabbatConfig,
  ShabbatWindow,
} from '@medguard/shared';

/** Shared fixture builders for the repository conformance suite — same shape as the fixtures
 * `apps/web/src/db/repository.test.ts` used before the Sprint A1 extraction. */

export const CONFORMANCE_NOW = '2026-06-15T12:00:00.000Z';
export const CONFORMANCE_TIMEZONE = 'Asia/Jerusalem';

/** A real UUID, not a human-readable placeholder like `"patient-1"` — every `patientId` field is
 * validated as a UUID at the sync boundary, and a non-UUID fixture would fail that validation the
 * moment one of these records ever crossed it. */
export const CONFORMANCE_PATIENT_ID = '99999999-9999-4999-8999-999999999999';

export function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: CONFORMANCE_PATIENT_ID,
    displayName: 'Yoni',
    archived: false,
    sortOrder: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'other-device',
    syncStatus: 'synced',
    ...overrides,
  };
}

export function makeMedicinePatient(overrides: Partial<MedicinePatient> = {}): MedicinePatient {
  return {
    id: `medicine-1:${CONFORMANCE_PATIENT_ID}`,
    medicineId: 'medicine-1',
    patientId: CONFORMANCE_PATIENT_ID,
    active: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'other-device',
    syncStatus: 'synced',
    ...overrides,
  };
}

export function makeMedicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'medicine-1',
    patientId: CONFORMANCE_PATIENT_ID,
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'other-device',
    syncStatus: 'synced',
    ...overrides,
  };
}

export function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    medicineId: 'medicine-1',
    patientId: CONFORMANCE_PATIENT_ID,
    frequencyType: 'daily',
    timesOfDay: ['08:00'],
    dosageQuantity: 1,
    startDate: '2026-06-01',
    active: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'other-device',
    syncStatus: 'synced',
    ...overrides,
  };
}

export function makeLog(overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id: 'log-1',
    patientId: CONFORMANCE_PATIENT_ID,
    medicineId: 'medicine-1',
    type: 'prn',
    status: 'taken',
    actualTime: CONFORMANCE_NOW,
    quantityTaken: 1,
    loggedByUserId: 'mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'pending',
    ...overrides,
  };
}

export function makeInventoryItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'item-1',
    medicineId: 'medicine-1',
    refillThreshold: 5,
    unitName: 'pills',
    updatedAt: CONFORMANCE_NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

export function makeInventoryAdjustment(
  overrides: Partial<InventoryAdjustment> = {},
): InventoryAdjustment {
  return {
    id: 'adjustment-1',
    medicineId: 'medicine-1',
    delta: -1,
    reason: 'dose',
    createdAt: CONFORMANCE_NOW,
    createdByUserId: 'mom',
    createdByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

/** The `occurrenceKey` shape (`${scheduleId}:${dueAt}`) the alarm layer keys snoozes by. */
export const CONFORMANCE_OCCURRENCE = `schedule-1:${CONFORMANCE_NOW}`;

export function makeDoseSnooze(overrides: Partial<DoseSnooze> = {}): DoseSnooze {
  return {
    id: 'snooze-1',
    occurrenceId: CONFORMANCE_OCCURRENCE,
    minutes: 20,
    count: 1,
    createdAt: CONFORMANCE_NOW,
    createdByUserId: 'mom',
    createdByDeviceId: 'device-1',
    syncStatus: 'pending',
    ...overrides,
  };
}

export function makeShabbatConfig(overrides: Partial<ShabbatConfig> = {}): ShabbatConfig {
  return {
    id: 'shabbat-config-1',
    patientId: CONFORMANCE_PATIENT_ID,
    autoShabbatEnabled: true,
    latitude: 31.7683,
    longitude: 35.2137,
    candleLightingOffsetMins: 18,
    havdalahDegreesOrMins: '8.5_degrees',
    israelHolidays: true,
    chimeDurationSeconds: 30,
    weekdayChimeDurationSeconds: 60,
    updatedAt: CONFORMANCE_NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'pending',
    ...overrides,
  };
}

/** Server-authored, so its `updatedByDeviceId` is the server rather than any phone. */
export function makeShabbatWindow(overrides: Partial<ShabbatWindow> = {}): ShabbatWindow {
  const startsAt = overrides.startsAt ?? '2026-06-19T16:20:00.000Z';
  return {
    id: `shabbat:${startsAt}`,
    patientId: CONFORMANCE_PATIENT_ID,
    kind: 'shabbat',
    label: 'Shabbat',
    startsAt,
    endsAt: '2026-06-20T17:30:00.000Z',
    generatedAt: CONFORMANCE_NOW,
    updatedAt: CONFORMANCE_NOW,
    updatedByDeviceId: 'server',
    syncStatus: 'synced',
    ...overrides,
  };
}

export function makeBundle(
  overrides: {
    patients?: Patient[];
    medicinePatients?: MedicinePatient[];
    medicines?: Medicine[];
    schedules?: Schedule[];
    intakeLogs?: IntakeLog[];
    inventoryItems?: InventoryItem[];
    inventoryAdjustments?: InventoryAdjustment[];
  } = {},
) {
  return {
    patients: overrides.patients ?? [makePatient()],
    medicinePatients: overrides.medicinePatients ?? [makeMedicinePatient()],
    medicines: overrides.medicines ?? [makeMedicine()],
    schedules: overrides.schedules ?? [makeSchedule()],
    intakeLogs: overrides.intakeLogs ?? [makeLog()],
    inventoryItems: overrides.inventoryItems ?? [makeInventoryItem()],
    inventoryAdjustments: overrides.inventoryAdjustments ?? [makeInventoryAdjustment()],
  };
}
