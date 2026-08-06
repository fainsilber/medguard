import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { computeQuantity } from '@medguard/shared';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import { MedGuardRepository } from '@medguard/store';
import { BetterSqliteDriver, SqliteStore, createSqliteSchema } from '@medguard/store/sqlite';

/**
 * Sprint A1's exit gate (docs/android-client-plan.md): "the offline create-medicine → schedule →
 * log-a-dose → verify-stock-decrement flow passes on Android with no backend running — the same
 * thing `offline-smoke.spec.ts` proves for web."
 *
 * What this test actually proves, precisely: the SQLite `Store` (`packages/store/src/sqlite/`)
 * upholds that flow, driven through `better-sqlite3` rather than through `expo-sqlite` on a real
 * device — the same substitution `src/runtime/icuSpike.test.ts` makes for Hermes/AD1, for the
 * same reason (this sandbox has no Android SDK, emulator, or physical device). `SqliteStore`
 * itself is identical either way — only `SqlDriver`'s implementation differs
 * (`ExpoSqliteDriver` in `expoSqliteDriver.ts` is the real one; `BetterSqliteDriver` is Node-only)
 * — so this is real coverage of the SQL and merge logic, not a stand-in for the on-device test.
 * `apps/android/README.md`'s "What hasn't been verified" tracks the gap this leaves.
 */

const NOW = '2026-06-15T12:00:00.000Z';

function freshStore() {
  const db = new Database(':memory:');
  createSqliteSchema(db);
  return new SqliteStore(new BetterSqliteDriver(db));
}

describe('offline flow — create medicine, schedule, log a dose, verify stock decrement', () => {
  it('decrements stock for a dose recorded with no backend running', async () => {
    const repository = new MedGuardRepository(freshStore(), {
      clock: fixedClock(NOW),
      ids: sequentialIds('offline'),
      userId: 'mom',
      deviceId: 'device-1',
    });

    await repository.saveMedicine(
      {
        id: 'medicine-1',
        patientId: 'patient-1',
        name: 'Ondansetron',
        strength: '4mg',
        form: 'pill',
        asNeeded: false,
        archived: false,
        updatedAt: NOW,
        updatedByDeviceId: 'device-1',
        syncStatus: 'pending',
      },
      'CREATE',
    );

    await repository.saveSchedule(
      {
        id: 'schedule-1',
        medicineId: 'medicine-1',
        patientId: 'patient-1',
        frequencyType: 'daily',
        timesOfDay: ['08:00'],
        dosageQuantity: 1,
        startDate: '2026-06-01',
        active: true,
        updatedAt: NOW,
        updatedByDeviceId: 'device-1',
        syncStatus: 'pending',
      },
      'CREATE',
    );

    await repository.adjustInventory({ medicineId: 'medicine-1', delta: 30, reason: 'initial' });

    await repository.recordDose({
      id: 'log-1',
      patientId: 'patient-1',
      medicineId: 'medicine-1',
      scheduleId: 'schedule-1',
      type: 'scheduled',
      status: 'taken',
      actualTime: NOW,
      quantityTaken: 1,
      loggedByUserId: 'mom',
      loggedByDeviceId: 'device-1',
      syncStatus: 'pending',
    });

    expect(computeQuantity(await repository.adjustmentsForMedicine('medicine-1'))).toBe(29);
    expect(await repository.logsForMedicine('medicine-1')).toHaveLength(1);
    // "No backend running" — every write above queued locally with nothing to push it anywhere.
    expect(await repository.pendingSyncCount()).toBe(5);
  });
});
