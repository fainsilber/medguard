import { SINGLE_PATIENT_ID } from '@medguard/shared';
import type { Medicine, Schedule } from '@medguard/shared';

/**
 * Minimal valid entities, so each test states only the fields it actually cares about and a
 * reader can tell at a glance which value the assertion depends on.
 */

export function medicine(overrides: Partial<Medicine> & { id: string }): Medicine {
  return {
    patientId: SINGLE_PATIENT_ID,
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: true,
    archived: false,
    updatedAt: '2026-06-15T00:00:00.000Z',
    updatedByDeviceId: 'seed-device',
    syncStatus: 'synced',
    ...overrides,
  };
}

export function schedule(
  overrides: Partial<Schedule> & { id: string; medicineId: string },
): Schedule {
  return {
    patientId: SINGLE_PATIENT_ID,
    frequencyType: 'daily',
    timesOfDay: ['08:00'],
    dosageQuantity: 1,
    startDate: '2026-01-01',
    active: true,
    updatedAt: '2026-06-15T00:00:00.000Z',
    updatedByDeviceId: 'seed-device',
    syncStatus: 'synced',
    ...overrides,
  };
}
