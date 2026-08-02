import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeQuantity, expandSchedules } from '@medguard/shared';
import type { IntakeLog, Medicine, Schedule } from '@medguard/shared';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import { MedGuardRepository } from './repository.js';
import { MedGuardDB } from './schema.js';

const NOW = '2026-06-15T12:00:00.000Z';
const JERUSALEM = 'Asia/Jerusalem';

let databaseCounter = 0;
let openDatabases: MedGuardDB[] = [];

function freshRepository() {
  const db = new MedGuardDB(`MedGuardTest-${++databaseCounter}`);
  openDatabases.push(db);
  const repository = new MedGuardRepository(db, {
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
  openDatabases = [];
});

function makeMedicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'medicine-1',
    patientId: 'patient-1',
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    archived: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'other-device',
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
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

function makeLog(overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id: 'log-1',
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    type: 'prn',
    status: 'taken',
    actualTime: NOW,
    quantityTaken: 1,
    loggedByUserId: 'mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'pending',
    ...overrides,
  };
}

describe('every mutation queues its own sync', () => {
  it('writes a medicine and its outbox row together', async () => {
    const { db, repository } = freshRepository();
    await repository.saveMedicine(makeMedicine(), 'CREATE');

    expect(await db.medicines.count()).toBe(1);
    const outbox = await repository.pendingSync();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ table: 'medicines', entityId: 'medicine-1', action: 'CREATE' });
  });

  it('stamps a locally-saved record as pending, attributed to this device', async () => {
    const { db, repository } = freshRepository();
    await repository.saveMedicine(makeMedicine());

    const saved = await db.medicines.get('medicine-1');
    expect(saved).toMatchObject({
      syncStatus: 'pending',
      updatedByDeviceId: 'device-1',
      updatedAt: NOW,
    });
  });

  it('queues a schedule save', async () => {
    const { repository } = freshRepository();
    await repository.saveSchedule(makeSchedule(), 'CREATE');
    expect(await repository.pendingSyncCount()).toBe(1);
  });

  it('queues a manual inventory adjustment', async () => {
    const { repository } = freshRepository();
    await repository.adjustInventory({ medicineId: 'medicine-1', delta: 30, reason: 'refill' });

    const outbox = await repository.pendingSync();
    expect(outbox[0]).toMatchObject({ table: 'inventoryAdjustments', action: 'CREATE' });
  });
});

describe('transactional integrity — the reason this layer exists', () => {
  it('saves nothing at all when the outbox write fails', async () => {
    // The failure this guards against is silent: a dose saved locally but never queued would
    // simply never reach the other caregiver's phone, with nothing to indicate it.
    const { db, repository } = freshRepository();
    vi.spyOn(db.syncOutbox, 'add').mockRejectedValue(new Error('quota exceeded'));

    await expect(repository.saveMedicine(makeMedicine())).rejects.toThrow('quota exceeded');

    expect(await db.medicines.count()).toBe(0);
  });

  it('records neither the dose nor the stock movement when the outbox write fails', async () => {
    const { db, repository } = freshRepository();
    vi.spyOn(db.syncOutbox, 'add').mockRejectedValue(new Error('quota exceeded'));

    await expect(repository.recordDose(makeLog())).rejects.toThrow('quota exceeded');

    expect(await db.intakeLogs.count()).toBe(0);
    expect(await db.inventoryAdjustments.count()).toBe(0);
  });

  it('leaves no orphan outbox row when the entity write fails', async () => {
    const { db, repository } = freshRepository();
    vi.spyOn(db.intakeLogs, 'put').mockRejectedValue(new Error('disk failure'));

    await expect(repository.recordDose(makeLog())).rejects.toThrow('disk failure');

    // An outbox row for a dose that never saved would sync a dose that never happened.
    expect(await db.syncOutbox.count()).toBe(0);
  });

  it('writes both schedule versions or neither', async () => {
    const { db, repository } = freshRepository();
    await repository.saveSchedule(makeSchedule(), 'CREATE');
    await db.syncOutbox.clear();

    vi.spyOn(db.schedules, 'bulkPut').mockRejectedValue(new Error('disk failure'));

    await expect(
      repository.reviseSchedule('schedule-1', { dosageQuantity: 2 }, '2026-06-15'),
    ).rejects.toThrow('disk failure');

    // A partial write would leave the household with no live schedule, or with two.
    expect(await db.schedules.count()).toBe(1);
    expect(await db.syncOutbox.count()).toBe(0);
  });
});

describe('recordDose', () => {
  it('decrements stock for a dose actually given', async () => {
    const { db, repository } = freshRepository();
    const { adjustment } = await repository.recordDose(makeLog({ quantityTaken: 2 }));

    expect(adjustment?.delta).toBe(-2);
    expect(await db.inventoryAdjustments.count()).toBe(1);
  });

  it('queues both the log and the stock movement', async () => {
    const { repository } = freshRepository();
    await repository.recordDose(makeLog());

    const tables = (await repository.pendingSync()).map((entry) => entry.table);
    expect(tables).toEqual(['intakeLogs', 'inventoryAdjustments']);
  });

  it('moves no stock for a skipped dose', async () => {
    const { db, repository } = freshRepository();
    const { adjustment } = await repository.recordDose(
      makeLog({ status: 'skipped', quantityTaken: 0 }),
    );

    expect(adjustment).toBeUndefined();
    expect(await db.inventoryAdjustments.count()).toBe(0);
    expect(await db.intakeLogs.count()).toBe(1);
  });

  it('moves no stock for a dose pending Shabbat reconciliation', async () => {
    const { db, repository } = freshRepository();
    await repository.recordDose(makeLog({ status: 'pending_shabbat' }));
    expect(await db.inventoryAdjustments.count()).toBe(0);
  });

  it('preserves an override on the stored log', async () => {
    const { db, repository } = freshRepository();
    await repository.recordDose(
      makeLog({
        override: { confirmedByUserId: 'dad', reason: 'Vomited the first dose', blockedBy: 'cooldown' },
      }),
    );

    const stored = await db.intakeLogs.get('log-1');
    expect(stored?.override?.confirmedByUserId).toBe('dad');
  });
});

describe('correctDose — append, never edit', () => {
  it('keeps the original log visible and adds the correction', async () => {
    const { db, repository } = freshRepository();
    await repository.recordDose(makeLog({ id: 'original', quantityTaken: 2 }));

    await repository.correctDose('original', makeLog({ id: 'corrected', quantityTaken: 1 }));

    expect(await db.intakeLogs.count()).toBe(2);
    expect((await db.intakeLogs.get('corrected'))?.supersedesId).toBe('original');
    expect(await db.intakeLogs.get('original')).toBeDefined();
  });

  it('reverses the original stock movement and applies the corrected one', async () => {
    const { repository } = freshRepository();
    await repository.adjustInventory({ medicineId: 'medicine-1', delta: 10, reason: 'initial' });
    await repository.recordDose(makeLog({ id: 'original', quantityTaken: 2 }));

    expect(computeQuantity(await repository.adjustmentsForMedicine('medicine-1'))).toBe(8);

    await repository.correctDose('original', makeLog({ id: 'corrected', quantityTaken: 1 }));

    // 10 − 2 (original) + 2 (reversal) − 1 (corrected) = 9
    expect(computeQuantity(await repository.adjustmentsForMedicine('medicine-1'))).toBe(9);
  });

  it('reverses stock when a dose is corrected to skipped', async () => {
    const { repository } = freshRepository();
    await repository.adjustInventory({ medicineId: 'medicine-1', delta: 10, reason: 'initial' });
    await repository.recordDose(makeLog({ id: 'original', quantityTaken: 2 }));

    await repository.correctDose(
      'original',
      makeLog({ id: 'corrected', status: 'skipped', quantityTaken: 0 }),
    );

    expect(computeQuantity(await repository.adjustmentsForMedicine('medicine-1'))).toBe(10);
  });

  it('still records the correction when the original moved no stock', async () => {
    const { db, repository } = freshRepository();
    await repository.recordDose(makeLog({ id: 'original', status: 'skipped', quantityTaken: 0 }));

    await repository.correctDose('original', makeLog({ id: 'corrected', quantityTaken: 1 }));

    expect(await db.intakeLogs.count()).toBe(2);
    expect(computeQuantity(await repository.adjustmentsForMedicine('medicine-1'))).toBe(-1);
  });

  it('refuses to correct a log that does not exist', async () => {
    const { repository } = freshRepository();
    await expect(repository.correctDose('missing', makeLog())).rejects.toThrow(/No such intake log/);
  });
});

describe('schedules', () => {
  it('writes both versions of a revision and queues each', async () => {
    const { db, repository } = freshRepository();
    await repository.saveSchedule(makeSchedule(), 'CREATE');
    await db.syncOutbox.clear();

    const revision = await repository.reviseSchedule(
      'schedule-1',
      { dosageQuantity: 2 },
      '2026-06-15',
    );

    expect(await db.schedules.count()).toBe(2);
    expect(revision.closed.endDate).toBe('2026-06-14');
    expect(revision.created.supersedesId).toBe('schedule-1');

    const outbox = await repository.pendingSync();
    expect(outbox.map((entry) => entry.action)).toEqual(['UPDATE', 'CREATE']);
  });

  it('produces a continuous dose series across a revision', async () => {
    const { repository } = freshRepository();
    await repository.saveSchedule(makeSchedule(), 'CREATE');
    await repository.reviseSchedule('schedule-1', { dosageQuantity: 5 }, '2026-06-15');

    const schedules = await repository.allSchedules();
    const occurrences = expandSchedules(
      schedules,
      {
        fromMs: Date.parse('2026-06-13T00:00:00.000Z'),
        toMs: Date.parse('2026-06-17T00:00:00.000Z'),
      },
      JERUSALEM,
    );

    // One dose a day through the changeover, with the quantity switching on the effective date.
    expect(occurrences.map((o) => [o.localDate, o.dosageQuantity])).toEqual([
      ['2026-06-13', 1],
      ['2026-06-14', 1],
      ['2026-06-15', 5],
      ['2026-06-16', 5],
    ]);
  });

  it('closes a schedule with no replacement', async () => {
    const { repository } = freshRepository();
    await repository.saveSchedule(makeSchedule(), 'CREATE');

    const closed = await repository.closeSchedule('schedule-1', '2026-06-15');
    expect(closed.active).toBe(false);
    expect(closed.endDate).toBe('2026-06-14');
  });

  it('refuses to revise or close a schedule that does not exist', async () => {
    const { repository } = freshRepository();
    await expect(repository.reviseSchedule('missing', {}, '2026-06-15')).rejects.toThrow(
      /No such schedule/,
    );
    await expect(repository.closeSchedule('missing', '2026-06-15')).rejects.toThrow(
      /No such schedule/,
    );
  });

  it('finds schedules by medicine', async () => {
    const { repository } = freshRepository();
    await repository.saveSchedule(makeSchedule({ id: 'a' }), 'CREATE');
    await repository.saveSchedule(makeSchedule({ id: 'b', medicineId: 'other' }), 'CREATE');

    expect(await repository.schedulesForMedicine('medicine-1')).toHaveLength(1);
  });
});

describe('medicines', () => {
  it('archives rather than deletes, so history keeps its reference', async () => {
    const { db, repository } = freshRepository();
    await repository.saveMedicine(makeMedicine(), 'CREATE');

    await repository.archiveMedicine('medicine-1');

    expect(await db.medicines.count()).toBe(1);
    expect((await repository.getMedicine('medicine-1'))?.archived).toBe(true);
    expect(await repository.activeMedicines()).toHaveLength(0);
  });

  it('refuses to archive a medicine that does not exist', async () => {
    const { repository } = freshRepository();
    await expect(repository.archiveMedicine('missing')).rejects.toThrow(/No such medicine/);
  });
});

describe('indexed history queries', () => {
  it('finds a medicine history since an instant, via the compound index', async () => {
    const { repository } = freshRepository();
    await repository.recordDose(makeLog({ id: 'old', actualTime: '2026-06-01T08:00:00.000Z' }));
    await repository.recordDose(makeLog({ id: 'recent', actualTime: '2026-06-15T08:00:00.000Z' }));

    const recent = await repository.logsForMedicine('medicine-1', '2026-06-10T00:00:00.000Z');
    expect(recent.map((log) => log.id)).toEqual(['recent']);
  });

  it('returns the whole history when no cutoff is given', async () => {
    const { repository } = freshRepository();
    await repository.recordDose(makeLog({ id: 'a', actualTime: '2026-06-01T08:00:00.000Z' }));
    await repository.recordDose(makeLog({ id: 'b', actualTime: '2026-06-15T08:00:00.000Z' }));

    expect(await repository.logsForMedicine('medicine-1')).toHaveLength(2);
  });

  it('finds a patient history within a window, for the Today view', async () => {
    const { repository } = freshRepository();
    await repository.recordDose(makeLog({ id: 'yesterday', actualTime: '2026-06-14T08:00:00.000Z' }));
    await repository.recordDose(makeLog({ id: 'today', actualTime: '2026-06-15T08:00:00.000Z' }));

    const today = await repository.logsForPatientBetween(
      'patient-1',
      '2026-06-15T00:00:00.000Z',
      '2026-06-16T00:00:00.000Z',
    );
    expect(today.map((log) => log.id)).toEqual(['today']);
  });
});

describe('outbox lifecycle', () => {
  it('drains oldest first', async () => {
    const { db, repository } = freshRepository();
    await db.syncOutbox.bulkAdd([
      { table: 'medicines', entityId: 'b', action: 'CREATE', payload: {}, createdAt: '2026-06-15T12:00:02.000Z', attempts: 0 },
      { table: 'medicines', entityId: 'a', action: 'CREATE', payload: {}, createdAt: '2026-06-15T12:00:01.000Z', attempts: 0 },
    ]);

    expect((await repository.pendingSync()).map((entry) => entry.entityId)).toEqual(['a', 'b']);
  });

  it('removes an entry once the server accepts it', async () => {
    const { repository } = freshRepository();
    await repository.saveMedicine(makeMedicine(), 'CREATE');
    const [entry] = await repository.pendingSync();

    await repository.markSynced(entry!.id!);
    expect(await repository.pendingSyncCount()).toBe(0);
  });

  it('records a failure without dropping the entry, so a stuck queue stays visible', async () => {
    const { repository } = freshRepository();
    await repository.saveMedicine(makeMedicine(), 'CREATE');
    const [entry] = await repository.pendingSync();

    await repository.markSyncFailed(entry!.id!, 'network unreachable');
    await repository.markSyncFailed(entry!.id!, 'network unreachable');

    const [retried] = await repository.pendingSync();
    expect(retried).toMatchObject({
      attempts: 2,
      lastError: 'network unreachable',
      lastAttemptAt: NOW,
    });
  });

  it('ignores a failure report for an entry already synced away', async () => {
    const { repository } = freshRepository();
    await expect(repository.markSyncFailed(999, 'gone')).resolves.toBeUndefined();
  });
});
