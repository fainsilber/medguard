import * as SQLite from 'expo-sqlite';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import type { IntakeLog } from '@medguard/shared';
import { MedGuardRepository } from '@medguard/store';
import { SqliteStore } from '@medguard/store/sqlite';
import { createSqliteSchema, ExpoSqliteDriver } from '../store/expoSqliteDriver.js';

/**
 * Opens a second repository against the same (mocked, shared-by-name) database a rendered
 * component wrote through, so tests can assert what actually landed in storage rather than only
 * that a UI panel closed. Read-only, so its own clock/ids don't matter.
 */
async function repositoryFor(dbName: string): Promise<MedGuardRepository> {
  const db = await SQLite.openDatabaseAsync(dbName);
  await createSqliteSchema(db);
  const store = new SqliteStore(new ExpoSqliteDriver(db));
  return new MedGuardRepository(store, {
    clock: fixedClock('2026-06-15T12:00:00.000Z'),
    ids: sequentialIds('reader'),
    userId: 'reader',
    deviceId: 'reader-device',
  });
}

export async function readLogsFromDb(dbName: string, medicineId: string): Promise<IntakeLog[]> {
  const repository = await repositoryFor(dbName);
  return repository.logsForMedicine(medicineId);
}

/**
 * Pre-seeds a log before a component under test mounts against the same `dbName` — needed for
 * `correctDose`, which requires the log it corrects to already exist in storage (it is not
 * enough for a test to pass the original as a prop; `DoseCorrection` only *reads* `tipLog` as a
 * prop, but `repository.correctDose` looks the original up by id in the real store).
 */
export async function seedLog(dbName: string, log: IntakeLog): Promise<void> {
  const repository = await repositoryFor(dbName);
  await repository.recordDose(log);
}
