import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import { manualClock, sequentialIds } from '@medguard/shared/testing';
import type { IntakeLog } from '@medguard/shared';
import { AndroidRepository } from './repository.js';
import { AndroidMedGuardDB } from './schema.js';
import { medicine, schedule } from '../testUtils/fixtures.js';

/**
 * The repository's whole reason to exist is that a mutation and its outbox row are written
 * together. These tests assert that pairing directly, because the failure it prevents — a dose
 * recorded on this phone that silently never reaches the other caregiver's — is invisible from
 * the UI.
 */

const NOW = '2026-06-15T12:00:00.000Z';

let databaseCounter = 0;
let db: AndroidMedGuardDB;
let repository: AndroidRepository;

beforeEach(() => {
  db = new AndroidMedGuardDB(`AndroidRepoTest-${(databaseCounter += 1)}`);
  repository = new AndroidRepository(db, {
    clock: manualClock(NOW),
    ids: sequentialIds('id'),
    userId: 'Mom',
    deviceId: 'device-1',
  });
});

afterEach(async () => {
  await db.delete();
});

function takenLog(overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id: 'log-1',
    patientId: SINGLE_PATIENT_ID,
    medicineId: 'med-1',
    type: 'prn',
    status: 'taken',
    actualTime: NOW,
    quantityTaken: 1,
    loggedByUserId: 'Mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'pending',
    ...overrides,
  };
}

describe('outbox pairing', () => {
  it('queues a medicine save with the table name the sync API dispatches on', async () => {
    await repository.saveMedicine(medicine({ id: 'med-1' }), 'CREATE');

    const [entry] = await repository.pendingSync();
    expect(entry).toMatchObject({
      table: 'medicines',
      entityId: 'med-1',
      action: 'CREATE',
      attempts: 0,
    });
  });

  it('queues a schedule save', async () => {
    await repository.saveSchedule(schedule({ id: 'sched-1', medicineId: 'med-1' }), 'CREATE');

    const [entry] = await repository.pendingSync();
    expect(entry).toMatchObject({ table: 'schedules', entityId: 'sched-1', action: 'CREATE' });
  });

  it('queues household settings', async () => {
    await repository.saveHouseholdSettings(
      {
        id: 'household',
        timeZone: 'Asia/Jerusalem',
        escalationAfterMinutes: 15,
        snoozeMinutes: 15,
        updatedAt: '',
        updatedByDeviceId: '',
        syncStatus: 'pending',
      },
      'CREATE',
    );

    const [entry] = await repository.pendingSync();
    expect(entry).toMatchObject({ table: 'householdSettings', entityId: 'household' });
  });

  it('records every outbox entry with a zero attempt count, so retry bookkeeping starts clean', async () => {
    await repository.saveMedicine(medicine({ id: 'med-1' }), 'CREATE');
    await repository.recordDose(takenLog());

    const entries = await repository.pendingSync();
    expect(entries.every((entry) => entry.attempts === 0)).toBe(true);
  });

  it('counts what is still queued', async () => {
    expect(await repository.pendingSyncCount()).toBe(0);
    await repository.saveMedicine(medicine({ id: 'med-1' }), 'CREATE');
    expect(await repository.pendingSyncCount()).toBe(1);
  });
});

describe('stamping', () => {
  it('overwrites attribution on save, so a caller cannot forget or forge it', async () => {
    await repository.saveMedicine(
      medicine({ id: 'med-1', updatedAt: 'nonsense', updatedByDeviceId: 'someone-else' }),
    );

    const saved = await db.medicines.get('med-1');
    expect(saved).toMatchObject({
      updatedAt: NOW,
      updatedByDeviceId: 'device-1',
      syncStatus: 'pending',
    });
  });
});

describe('recordDose', () => {
  it('appends the log and its stock decrement together', async () => {
    const { adjustment } = await repository.recordDose(takenLog({ quantityTaken: 2 }));

    expect(await db.intakeLogs.get('log-1')).toBeDefined();
    expect(adjustment).toMatchObject({
      medicineId: 'med-1',
      delta: -2,
      reason: 'dose',
      relatedLogId: 'log-1',
    });
    expect(await db.inventoryAdjustments.count()).toBe(1);
  });

  it('queues both the log and the adjustment for upload', async () => {
    await repository.recordDose(takenLog());

    const tables = (await repository.pendingSync()).map((entry) => entry.table);
    expect(tables).toEqual(['intakeLogs', 'inventoryAdjustments']);
  });

  it('moves no stock for a dose that was not given', async () => {
    // A skipped dose is a real, recorded fact — it just did not consume anything.
    const { adjustment } = await repository.recordDose(takenLog({ status: 'skipped' }));

    expect(adjustment).toBeUndefined();
    expect(await db.inventoryAdjustments.count()).toBe(0);
    expect(await db.intakeLogs.count()).toBe(1);
  });

  it('keeps the override audit record on the stored log', async () => {
    await repository.recordDose(
      takenLog({
        override: { confirmedByUserId: 'Mom', reason: 'Doctor said so', blockedBy: 'cooldown' },
      }),
    );

    const stored = await db.intakeLogs.get('log-1');
    expect(stored?.override).toEqual({
      confirmedByUserId: 'Mom',
      reason: 'Doctor said so',
      blockedBy: 'cooldown',
    });
  });
});

describe('inventory', () => {
  it('appends a manual adjustment rather than writing a running total', async () => {
    const adjustment = await repository.adjustInventory({
      medicineId: 'med-1',
      delta: 30,
      reason: 'refill',
    });

    expect(adjustment.delta).toBe(30);
    expect(await db.inventoryAdjustments.count()).toBe(1);

    const [entry] = await repository.pendingSync();
    expect(entry).toMatchObject({ table: 'inventoryAdjustments', action: 'CREATE' });
  });

  it('accumulates concurrent refills instead of letting one overwrite the other', async () => {
    await repository.adjustInventory({ medicineId: 'med-1', delta: 30, reason: 'refill' });
    await repository.adjustInventory({ medicineId: 'med-1', delta: 20, reason: 'refill' });

    const total = (await db.inventoryAdjustments.toArray()).reduce(
      (sum, adjustment) => sum + adjustment.delta,
      0,
    );
    expect(total).toBe(50);
  });

  it('saves and reads back the tracking config for a medicine', async () => {
    await repository.saveInventoryItem(
      {
        id: 'inv-1',
        medicineId: 'med-1',
        refillThreshold: 5,
        unitName: 'pills',
        updatedAt: '',
        updatedByDeviceId: '',
        syncStatus: 'pending',
      },
      'CREATE',
    );

    const item = await repository.getInventoryItem('med-1');
    expect(item).toMatchObject({ id: 'inv-1', refillThreshold: 5, unitName: 'pills' });

    const [entry] = await repository.pendingSync();
    expect(entry).toMatchObject({ table: 'inventoryItems', entityId: 'inv-1' });
  });

  it('returns undefined for a medicine with no tracking config', async () => {
    expect(await repository.getInventoryItem('med-unknown')).toBeUndefined();
  });
});
