import * as SQLite from 'expo-sqlite';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import type {
  DoseSnooze,
  HouseholdSettings,
  IsoInstant,
  Medicine,
  Schedule,
  ShabbatConfig,
  ShabbatWindow,
} from '@medguard/shared';
import { MedGuardRepository, setLastSyncedAt } from '@medguard/store';
import type { Store } from '@medguard/store';
import { SqliteStore } from '@medguard/store/sqlite';
import { createSqliteSchema, ExpoSqliteDriver } from '../store/expoSqliteDriver.js';

/**
 * Opens a second store/repository against the same (mocked, shared-by-name) database a rendered
 * component reads from — same pattern as `readSchedules.ts`, extended to cover the tables the
 * alarm layer added (household settings, snoozes, sync metadata).
 */
async function storeFor(dbName: string): Promise<Store> {
  const db = await SQLite.openDatabaseAsync(dbName);
  await createSqliteSchema(db);
  return new SqliteStore(new ExpoSqliteDriver(db));
}

async function repositoryFor(dbName: string): Promise<MedGuardRepository> {
  const store = await storeFor(dbName);
  return new MedGuardRepository(store, {
    clock: fixedClock('2026-06-15T12:00:00.000Z'),
    ids: sequentialIds('seed'),
    userId: 'seed-user',
    deviceId: 'seed-device',
  });
}

export async function seedLastSyncedAt(dbName: string, iso: IsoInstant): Promise<void> {
  const store = await storeFor(dbName);
  await setLastSyncedAt(store, iso);
}

export async function seedHouseholdSettings(dbName: string, overrides: Partial<HouseholdSettings> = {}): Promise<void> {
  const repository = await repositoryFor(dbName);
  await repository.saveHouseholdSettings(
    {
      id: 'household',
      timeZone: 'Asia/Jerusalem',
      escalationAfterMinutes: 15,
      snoozeMinutes: 20,
      updatedAt: '',
      updatedByDeviceId: '',
      syncStatus: 'pending',
      ...overrides,
    },
    'CREATE',
  );
}

export async function seedMedicine(dbName: string, medicine: Medicine): Promise<void> {
  const repository = await repositoryFor(dbName);
  await repository.saveMedicine(medicine, 'CREATE');
}

export async function seedScheduleFor(dbName: string, schedule: Schedule): Promise<void> {
  const repository = await repositoryFor(dbName);
  await repository.saveSchedule(schedule, 'CREATE');
}

export async function seedSnooze(dbName: string, snooze: DoseSnooze): Promise<void> {
  const repository = await repositoryFor(dbName);
  await repository.recordSnooze(snooze);
}

export async function seedShabbatConfig(dbName: string, config: ShabbatConfig): Promise<void> {
  const repository = await repositoryFor(dbName);
  await repository.saveShabbatConfig(config, 'CREATE');
}

/**
 * Windows are server-authored — the repository deliberately has no writer for them — so they are
 * seeded through the raw store, which is exactly how a sync pull lands them.
 */
export async function seedShabbatWindows(dbName: string, windows: ShabbatWindow[]): Promise<void> {
  const store = await storeFor(dbName);
  await store.transaction(['shabbatWindows'], async (tx) => {
    for (const window of windows) {
      await tx.put('shabbatWindows', window);
    }
  });
}

export async function readSnoozes(dbName: string, occurrenceId: string): Promise<DoseSnooze[]> {
  const repository = await repositoryFor(dbName);
  return repository.snoozesForOccurrence(occurrenceId);
}
