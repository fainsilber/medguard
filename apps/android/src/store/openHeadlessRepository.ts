import * as SQLite from 'expo-sqlite';
import { MedGuardRepository } from '@medguard/store';
import type { Store } from '@medguard/store';
import { SqliteStore } from '@medguard/store/sqlite';
import { getCaregiverName } from '../identity/caregiverName.js';
import { getOrCreateDeviceId } from '../identity/deviceId.js';
import { deviceClock, deviceIdGenerator } from '../runtime/deviceRuntime.js';
import { ExpoSqliteDriver, createSqliteSchema } from './expoSqliteDriver.js';

/**
 * Builds the repository for code that runs with no component tree — the Taken/Snooze headless
 * task and the periodic background sync. The one place outside `RepositoryContext` that opens the
 * database, shared so the two no-UI entry points cannot drift apart.
 *
 * Returns `null` when no caregiver has identified themselves on this device: there is nobody to
 * attribute a write to (safety invariant 5), so callers must skip and leave the work for the next
 * app launch, where the app can ask.
 */
export interface HeadlessRepository {
  store: Store;
  repository: MedGuardRepository;
  userId: string;
  deviceId: string;
}

export async function openHeadlessRepository(): Promise<HeadlessRepository | null> {
  const [userId, deviceId] = await Promise.all([getCaregiverName(), getOrCreateDeviceId()]);
  if (!userId) {
    return null;
  }

  const db = await SQLite.openDatabaseAsync('medguard.db');
  await createSqliteSchema(db);
  const store = new SqliteStore(new ExpoSqliteDriver(db));
  const repository = new MedGuardRepository(store, {
    clock: deviceClock,
    ids: deviceIdGenerator,
    userId,
    deviceId,
  });
  return { store, repository, userId, deviceId };
}
