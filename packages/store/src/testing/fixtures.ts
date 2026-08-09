import type {
  DoseSnooze,
  IntakeLog,
  InventoryAdjustment,
  InventoryItem,
  Medicine,
  Schedule,
} from '@medguard/shared';

/** Shared fixture builders for the repository conformance suite — same shape as the fixtures
 * `apps/web/src/db/repository.test.ts` used before the Sprint A1 extraction. */

export const CONFORMANCE_NOW = '2026-06-15T12:00:00.000Z';
export const CONFORMANCE_TIMEZONE = 'Asia/Jerusalem';

export function makeMedicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'medicine-1',
    patientId: 'patient-1',
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
    patientId: 'patient-1',
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
    patientId: 'patient-1',
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

export function makeInventoryAdjustment(overrides: Partial<InventoryAdjustment> = {}): InventoryAdjustment {
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

export function makeBundle(
  overrides: {
    medicines?: Medicine[];
    schedules?: Schedule[];
    intakeLogs?: IntakeLog[];
    inventoryItems?: InventoryItem[];
    inventoryAdjustments?: InventoryAdjustment[];
  } = {},
) {
  return {
    medicines: overrides.medicines ?? [makeMedicine()],
    schedules: overrides.schedules ?? [makeSchedule()],
    intakeLogs: overrides.intakeLogs ?? [makeLog()],
    inventoryItems: overrides.inventoryItems ?? [makeInventoryItem()],
    inventoryAdjustments: overrides.inventoryAdjustments ?? [makeInventoryAdjustment()],
  };
}
