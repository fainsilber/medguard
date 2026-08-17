import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import { MedGuardRepository } from '../repository.js';
import { makeBundle, makeLog, makeMedicine, makeSchedule } from '../testing/fixtures.js';
import { DexieStore } from './dexieStore.js';

/**
 * "Every mutation and its sync-outbox row are written in one transaction" is the entire reason
 * `MedGuardRepository` exists (see its module doc). Proving that needs a real mid-transaction
 * failure, which needs a specific backend's real handle to inject — so unlike
 * `repositoryConformance.ts`, this file is Dexie-specific on purpose, and stays here rather than
 * being generalized across backends. `apps/web`'s original `db/repository.test.ts` carried these
 * same cases before the Sprint A1 extraction; nothing here is new coverage, just relocated.
 */

const NOW = '2026-06-15T12:00:00.000Z';

class TestDB extends Dexie {
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      householdSettings: 'id',
      patients: 'id, archived, sortOrder',
      medicinePatients: 'id, medicineId, patientId, active',
      medicines: 'id, patientId, name, archived, syncStatus, updatedAt',
      schedules: 'id, medicineId, patientId, active, regimenGroupId, syncStatus, updatedAt',
      intakeLogs:
        'id, patientId, medicineId, scheduleId, status, type, actualTime, syncStatus, supersedesId, [medicineId+actualTime], [patientId+actualTime]',
      inventoryItems: 'id, medicineId, syncStatus, updatedAt',
      inventoryAdjustments: 'id, medicineId, relatedLogId, createdAt, syncStatus',
      doseSnoozes: 'id, occurrenceId, createdAt, syncStatus',
      shabbatConfig: 'id, patientId',
      shabbatWindows: 'id, patientId, startsAt',
      syncOutbox: '++id, table, entityId, action, createdAt',
      syncMeta: 'key',
    });
  }
}

let counter = 0;
const openDatabases: { delete(): Promise<unknown> }[] = [];

function freshRepository() {
  const db = new TestDB(`store-tx-integrity-${++counter}`);
  openDatabases.push(db);
  const repository = new MedGuardRepository(new DexieStore(db), {
    clock: fixedClock(NOW),
    ids: sequentialIds('generated'),
    userId: 'mom',
    deviceId: 'device-1',
  });
  return { db, repository };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of openDatabases) {
    await db.delete();
  }
  openDatabases.length = 0;
});

describe('transactional integrity — the reason this layer exists', () => {
  it('saves nothing at all when the outbox write fails', async () => {
    // The failure this guards against is silent: a dose saved locally but never queued would
    // simply never reach the other caregiver's phone, with nothing to indicate it.
    const { db, repository } = freshRepository();
    vi.spyOn(db.table('syncOutbox'), 'add').mockRejectedValue(new Error('quota exceeded'));

    await expect(repository.saveMedicine(makeMedicine())).rejects.toThrow('quota exceeded');

    expect(await db.table('medicines').count()).toBe(0);
  });

  it('records neither the dose nor the stock movement when the outbox write fails', async () => {
    const { db, repository } = freshRepository();
    vi.spyOn(db.table('syncOutbox'), 'add').mockRejectedValue(new Error('quota exceeded'));

    await expect(repository.recordDose(makeLog())).rejects.toThrow('quota exceeded');

    expect(await db.table('intakeLogs').count()).toBe(0);
    expect(await db.table('inventoryAdjustments').count()).toBe(0);
  });

  it('leaves no orphan outbox row when the entity write fails', async () => {
    const { db, repository } = freshRepository();
    vi.spyOn(db.table('intakeLogs'), 'put').mockRejectedValue(new Error('disk failure'));

    await expect(repository.recordDose(makeLog())).rejects.toThrow('disk failure');

    // An outbox row for a dose that never saved would sync a dose that never happened.
    expect(await db.table('syncOutbox').count()).toBe(0);
  });

  it('writes both schedule versions or neither', async () => {
    const { db, repository } = freshRepository();
    await repository.saveSchedule(makeSchedule(), 'CREATE');
    await db.table('syncOutbox').clear();

    vi.spyOn(db.table('schedules'), 'bulkPut').mockRejectedValue(new Error('disk failure'));

    await expect(
      repository.reviseSchedule('schedule-1', { dosageQuantity: 2 }, '2026-06-15'),
    ).rejects.toThrow('disk failure');

    // A partial write would leave the household with no live schedule, or with two.
    expect(await db.table('schedules').count()).toBe(1);
    expect(await db.table('syncOutbox').count()).toBe(0);
  });

  it('writes nothing at all when one table fails partway through restoreBackup', async () => {
    const { db, repository } = freshRepository();
    vi.spyOn(db.table('inventoryAdjustments'), 'bulkPut').mockRejectedValue(
      new Error('disk failure'),
    );

    await expect(repository.restoreBackup(makeBundle())).rejects.toThrow('disk failure');

    // A partially-applied backup — some tables restored, others not — would leave the household
    // in a state matching neither the backup nor what was there before.
    expect(await db.table('patients').count()).toBe(0);
    expect(await db.table('medicinePatients').count()).toBe(0);
    expect(await db.table('medicines').count()).toBe(0);
    expect(await db.table('schedules').count()).toBe(0);
    expect(await db.table('intakeLogs').count()).toBe(0);
    expect(await db.table('syncOutbox').count()).toBe(0);
  });

  it('clears nothing at all if any table fails to clear', async () => {
    const { db, repository } = freshRepository();
    await repository.restoreBackup(makeBundle());
    vi.spyOn(db.table('inventoryAdjustments'), 'clear').mockRejectedValue(
      new Error('disk failure'),
    );

    await expect(repository.clearAllData()).rejects.toThrow('disk failure');

    expect(await db.table('medicines').count()).toBe(1);
  });
});
