import { describe, expect, it } from 'vitest';
import { computeQuantity, expandSchedules } from '@medguard/shared';
import type { Clock } from '@medguard/shared';
import { fixedClock, manualClock, sequentialIds } from '@medguard/shared/testing';
import { MedGuardRepository } from '../repository.js';
import type { Store } from '../types.js';
import {
  CONFORMANCE_NOW as NOW,
  CONFORMANCE_OCCURRENCE as OCCURRENCE,
  CONFORMANCE_TIMEZONE as JERUSALEM,
  makeBundle,
  makeDoseSnooze,
  makeInventoryAdjustment,
  makeInventoryItem,
  makeLog,
  makeMedicine,
  makeSchedule,
  makeShabbatConfig,
  makeShabbatWindow,
} from './fixtures.js';

/**
 * Runs the same behavioral suite against any `Store` implementation — the proof, per
 * docs/android-client-plan.md ("Test strategy"), that "the port didn't change anything" is a test
 * result rather than a claim. Every assertion goes through `MedGuardRepository`'s public API only,
 * never a backend's raw handle, so passing this suite against a new `Store` is by construction the
 * same thing as passing it against Dexie or SQLite.
 *
 * What this suite does *not* cover: transaction-rollback-under-fault-injection (e.g. "the outbox
 * write throws partway through — does the whole write roll back?"). That needs to reach into a
 * specific backend to force the failure, so it lives next to each backend instead
 * (`dexie/dexieStore.transactionIntegrity.test.ts`) rather than here.
 */
export function runRepositoryConformanceSuite(backendName: string, makeStore: () => Store | Promise<Store>): void {
  async function freshRepository(clock: Clock = fixedClock(NOW)) {
    const store = await makeStore();
    const repository = new MedGuardRepository(store, {
      clock,
      ids: sequentialIds('generated'),
      userId: 'mom',
      deviceId: 'device-1',
    });
    return { store, repository };
  }

  describe(`MedGuardRepository — ${backendName} conformance`, () => {
    describe('every mutation queues its own sync', () => {
      it('writes a medicine and its outbox row together', async () => {
        const { repository } = await freshRepository();
        await repository.saveMedicine(makeMedicine(), 'CREATE');

        expect(await repository.getMedicine('medicine-1')).toBeDefined();
        const outbox = await repository.pendingSync();
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({ table: 'medicines', entityId: 'medicine-1', action: 'CREATE' });
      });

      it('stamps a locally-saved record as pending, attributed to this device', async () => {
        const { repository } = await freshRepository();
        await repository.saveMedicine(makeMedicine());

        const saved = await repository.getMedicine('medicine-1');
        expect(saved).toMatchObject({ syncStatus: 'pending', updatedByDeviceId: 'device-1', updatedAt: NOW });
      });

      it('queues a schedule save', async () => {
        const { repository } = await freshRepository();
        await repository.saveSchedule(makeSchedule(), 'CREATE');
        expect(await repository.pendingSyncCount()).toBe(1);
      });

      it('queues a manual inventory adjustment', async () => {
        const { repository } = await freshRepository();
        await repository.adjustInventory({ medicineId: 'medicine-1', delta: 30, reason: 'refill' });

        const outbox = await repository.pendingSync();
        expect(outbox[0]).toMatchObject({ table: 'inventoryAdjustments', action: 'CREATE' });
      });
    });

    describe('recordDose — the offline create-medicine → schedule → log-a-dose → verify-stock flow', () => {
      it('decrements stock for a dose actually given', async () => {
        const { repository } = await freshRepository();
        await repository.saveMedicine(makeMedicine(), 'CREATE');
        await repository.saveSchedule(makeSchedule(), 'CREATE');
        await repository.adjustInventory({ medicineId: 'medicine-1', delta: 30, reason: 'initial' });

        const { adjustment } = await repository.recordDose(makeLog({ quantityTaken: 2 }));

        expect(adjustment?.delta).toBe(-2);
        expect(computeQuantity(await repository.adjustmentsForMedicine('medicine-1'))).toBe(28);
      });

      it('queues both the log and the stock movement', async () => {
        const { repository } = await freshRepository();
        await repository.recordDose(makeLog());

        const tables = (await repository.pendingSync()).map((entry) => entry.table);
        expect(tables).toEqual(['intakeLogs', 'inventoryAdjustments']);
      });

      it('moves no stock for a skipped dose', async () => {
        const { repository } = await freshRepository();
        const { adjustment } = await repository.recordDose(makeLog({ status: 'skipped', quantityTaken: 0 }));

        expect(adjustment).toBeUndefined();
        expect(await repository.adjustmentsForMedicine('medicine-1')).toHaveLength(0);
      });

      it('moves no stock for a dose pending Shabbat reconciliation', async () => {
        const { repository } = await freshRepository();
        await repository.recordDose(makeLog({ status: 'pending_shabbat' }));
        expect(await repository.adjustmentsForMedicine('medicine-1')).toHaveLength(0);
      });

      it('preserves an override on the stored log', async () => {
        const { repository } = await freshRepository();
        await repository.recordDose(
          makeLog({ override: { confirmedByUserId: 'dad', reason: 'Vomited the first dose', blockedBy: 'cooldown' } }),
        );

        const logs = await repository.logsForMedicine('medicine-1');
        expect(logs[0]?.override?.confirmedByUserId).toBe('dad');
      });
    });

    describe('correctDose — append, never edit', () => {
      it('keeps the original log visible and adds the correction', async () => {
        const { repository } = await freshRepository();
        await repository.recordDose(makeLog({ id: 'original', quantityTaken: 2 }));

        await repository.correctDose('original', makeLog({ id: 'corrected', quantityTaken: 1 }));

        const logs = await repository.logsForMedicine('medicine-1');
        expect(logs).toHaveLength(2);
        expect(logs.find((l) => l.id === 'corrected')?.supersedesId).toBe('original');
      });

      it('reverses the original stock movement and applies the corrected one', async () => {
        const { repository } = await freshRepository();
        await repository.adjustInventory({ medicineId: 'medicine-1', delta: 10, reason: 'initial' });
        await repository.recordDose(makeLog({ id: 'original', quantityTaken: 2 }));

        expect(computeQuantity(await repository.adjustmentsForMedicine('medicine-1'))).toBe(8);

        await repository.correctDose('original', makeLog({ id: 'corrected', quantityTaken: 1 }));

        // 10 − 2 (original) + 2 (reversal) − 1 (corrected) = 9
        expect(computeQuantity(await repository.adjustmentsForMedicine('medicine-1'))).toBe(9);
      });

      it('reverses stock when a dose is corrected to skipped', async () => {
        const { repository } = await freshRepository();
        await repository.adjustInventory({ medicineId: 'medicine-1', delta: 10, reason: 'initial' });
        await repository.recordDose(makeLog({ id: 'original', quantityTaken: 2 }));

        await repository.correctDose('original', makeLog({ id: 'corrected', status: 'skipped', quantityTaken: 0 }));

        expect(computeQuantity(await repository.adjustmentsForMedicine('medicine-1'))).toBe(10);
      });

      it('still records the correction when the original moved no stock', async () => {
        const { repository } = await freshRepository();
        await repository.recordDose(makeLog({ id: 'original', status: 'skipped', quantityTaken: 0 }));

        await repository.correctDose('original', makeLog({ id: 'corrected', quantityTaken: 1 }));

        expect(await repository.logsForMedicine('medicine-1')).toHaveLength(2);
        expect(computeQuantity(await repository.adjustmentsForMedicine('medicine-1'))).toBe(-1);
      });

      it('refuses to correct a log that does not exist', async () => {
        const { repository } = await freshRepository();
        await expect(repository.correctDose('missing', makeLog())).rejects.toThrow(/No such intake log/);
      });
    });

    describe('schedules', () => {
      it('writes both versions of a revision and queues each', async () => {
        const { repository } = await freshRepository();
        await repository.saveSchedule(makeSchedule(), 'CREATE');

        const revision = await repository.reviseSchedule('schedule-1', { dosageQuantity: 2 }, '2026-06-15');

        expect(await repository.allSchedules()).toHaveLength(2);
        expect(revision.closed.endDate).toBe('2026-06-14');
        expect(revision.created.supersedesId).toBe('schedule-1');
      });

      it('produces a continuous dose series across a revision', async () => {
        const { repository } = await freshRepository();
        await repository.saveSchedule(makeSchedule(), 'CREATE');
        await repository.reviseSchedule('schedule-1', { dosageQuantity: 5 }, '2026-06-15');

        const schedules = await repository.allSchedules();
        const occurrences = expandSchedules(
          schedules,
          { fromMs: Date.parse('2026-06-13T00:00:00.000Z'), toMs: Date.parse('2026-06-17T00:00:00.000Z') },
          JERUSALEM,
        );

        expect(occurrences.map((o) => [o.localDate, o.dosageQuantity])).toEqual([
          ['2026-06-13', 1],
          ['2026-06-14', 1],
          ['2026-06-15', 5],
          ['2026-06-16', 5],
        ]);
      });

      it('closes a schedule with no replacement', async () => {
        const { repository } = await freshRepository();
        await repository.saveSchedule(makeSchedule(), 'CREATE');

        const closed = await repository.closeSchedule('schedule-1', '2026-06-15');
        expect(closed.active).toBe(false);
        expect(closed.endDate).toBe('2026-06-14');
      });

      it('refuses to revise or close a schedule that does not exist', async () => {
        const { repository } = await freshRepository();
        await expect(repository.reviseSchedule('missing', {}, '2026-06-15')).rejects.toThrow(/No such schedule/);
        await expect(repository.closeSchedule('missing', '2026-06-15')).rejects.toThrow(/No such schedule/);
      });

      it('finds schedules by medicine', async () => {
        const { repository } = await freshRepository();
        await repository.saveSchedule(makeSchedule({ id: 'a' }), 'CREATE');
        await repository.saveSchedule(makeSchedule({ id: 'b', medicineId: 'other' }), 'CREATE');

        expect(await repository.schedulesForMedicine('medicine-1')).toHaveLength(1);
      });
    });

    describe('household settings', () => {
      it('is absent before it is ever set', async () => {
        const { repository } = await freshRepository();
        expect(await repository.getHouseholdSettings()).toBeUndefined();
      });

      it('saves and reads back the household timezone', async () => {
        const { repository } = await freshRepository();
        await repository.saveHouseholdSettings({
          id: 'household',
          timeZone: 'Asia/Jerusalem',
          escalationAfterMinutes: 15,
          snoozeMinutes: 15,
          updatedAt: '2020-01-01T00:00:00.000Z',
          updatedByDeviceId: 'placeholder',
          syncStatus: 'synced',
        });

        expect(await repository.getHouseholdSettings()).toMatchObject({ timeZone: 'Asia/Jerusalem' });
      });
    });

    describe('shabbat (Sprint A5)', () => {
      it('has no config until a household sets one — which is not the same as automation being off', async () => {
        const { repository } = await freshRepository();
        expect(await repository.getShabbatConfig()).toBeUndefined();
        expect(await repository.allShabbatWindows()).toEqual([]);
      });

      it('saves the config locally and queues it for sync in one transaction', async () => {
        const { repository } = await freshRepository();
        await repository.saveShabbatConfig(makeShabbatConfig(), 'CREATE');

        expect(await repository.getShabbatConfig()).toMatchObject({
          latitude: 31.7683,
          israelHolidays: true,
          candleLightingOffsetMins: 18,
        });

        const outbox = await repository.pendingSync();
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({ table: 'shabbatConfig', action: 'CREATE' });
      });

      it('queues a later edit as an update', async () => {
        const { repository } = await freshRepository();
        await repository.saveShabbatConfig(makeShabbatConfig(), 'CREATE');
        await repository.markSynced((await repository.pendingSync())[0]!.id!);

        // No action argument: an edit to an existing config is an update, which is what the
        // server's last-write-wins merge expects to receive.
        await repository.saveShabbatConfig(makeShabbatConfig({ candleLightingOffsetMins: 40 }));

        const outbox = await repository.pendingSync();
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({ table: 'shabbatConfig', action: 'UPDATE' });
        expect(await repository.getShabbatConfig()).toMatchObject({
          candleLightingOffsetMins: 40,
        });
      });

      it('reads back windows that arrived from the server', async () => {
        const { store, repository } = await freshRepository();

        // Windows are never written by this device — they land through `applyPulledRecord`, which
        // writes them straight into the table. Simulated here by writing them the same way.
        await store.transaction(['shabbatWindows'], async (tx) => {
          await tx.put('shabbatWindows', makeShabbatWindow());
          await tx.put(
            'shabbatWindows',
            makeShabbatWindow({
              startsAt: '2026-06-26T16:22:00.000Z',
              endsAt: '2026-06-27T17:32:00.000Z',
            }),
          );
        });

        const windows = await repository.allShabbatWindows();
        expect(windows).toHaveLength(2);
        expect(windows.map((window) => window.kind)).toEqual(['shabbat', 'shabbat']);

        // Nothing was queued for upload: this table only ever travels one way.
        expect(await repository.pendingSync()).toEqual([]);
      });
    });

    describe('inventory items', () => {
      it('is absent before stock tracking is set up for a medicine', async () => {
        const { repository } = await freshRepository();
        expect(await repository.getInventoryItem('medicine-1')).toBeUndefined();
      });

      it('defaults to an UPDATE action when none is given', async () => {
        const { repository } = await freshRepository();
        await repository.saveInventoryItem(makeInventoryItem());

        const outbox = await repository.pendingSync();
        expect(outbox[0]).toMatchObject({ table: 'inventoryItems', action: 'UPDATE' });
      });

      it('saves and reads back stock-tracking config by medicine id', async () => {
        const { repository } = await freshRepository();
        await repository.saveInventoryItem(makeInventoryItem(), 'CREATE');

        expect(await repository.getInventoryItem('medicine-1')).toMatchObject({
          refillThreshold: 5,
          unitName: 'pills',
        });
        expect(await repository.allInventoryItems()).toHaveLength(1);
      });
    });

    describe('medicines', () => {
      it('archives rather than deletes, so history keeps its reference', async () => {
        const { repository } = await freshRepository();
        await repository.saveMedicine(makeMedicine(), 'CREATE');

        await repository.archiveMedicine('medicine-1');

        expect((await repository.getMedicine('medicine-1'))?.archived).toBe(true);
        expect(await repository.activeMedicines()).toHaveLength(0);
      });

      it('refuses to archive a medicine that does not exist', async () => {
        const { repository } = await freshRepository();
        await expect(repository.archiveMedicine('missing')).rejects.toThrow(/No such medicine/);
      });

      it('allMedicines includes archived ones that activeMedicines excludes', async () => {
        const { repository } = await freshRepository();
        await repository.saveMedicine(makeMedicine(), 'CREATE');
        await repository.archiveMedicine('medicine-1');

        expect(await repository.activeMedicines()).toHaveLength(0);
        expect(await repository.allMedicines()).toHaveLength(1);
      });

      it('closes the active schedule when a medicine is switched to as-needed', async () => {
        const { repository } = await freshRepository();
        await repository.saveMedicine(makeMedicine({ asNeeded: false }), 'CREATE');
        await repository.saveSchedule(makeSchedule(), 'CREATE');

        await repository.saveMedicine(makeMedicine({ asNeeded: true }));

        const [schedule] = await repository.schedulesForMedicine('medicine-1');
        expect(schedule!.active).toBe(false);
        expect(schedule!.endDate).toBe('2026-06-14');

        const outboxTables = (await repository.pendingSync()).map((entry) => entry.table);
        expect(outboxTables).toContain('schedules');
      });

      it('produces no more occurrences once its schedule is closed by going as-needed', async () => {
        const { repository } = await freshRepository();
        await repository.saveMedicine(makeMedicine({ asNeeded: false }), 'CREATE');
        await repository.saveSchedule(makeSchedule(), 'CREATE');

        await repository.saveMedicine(makeMedicine({ asNeeded: true }));

        const schedules = await repository.allSchedules();
        const occurrences = expandSchedules(
          schedules,
          { fromMs: Date.parse('2026-06-15T00:00:00.000Z'), toMs: Date.parse('2026-06-20T00:00:00.000Z') },
          JERUSALEM,
        );
        expect(occurrences).toHaveLength(0);
      });

      it('leaves schedules alone when a medicine is saved without changing as-needed', async () => {
        const { repository } = await freshRepository();
        await repository.saveMedicine(makeMedicine({ asNeeded: false }), 'CREATE');
        await repository.saveSchedule(makeSchedule(), 'CREATE');

        await repository.saveMedicine(makeMedicine({ asNeeded: false, name: 'Renamed' }));

        const [schedule] = await repository.schedulesForMedicine('medicine-1');
        expect(schedule!.active).toBe(true);
      });
    });

    describe('indexed history queries', () => {
      it('finds a medicine history since an instant, via the compound index', async () => {
        const { repository } = await freshRepository();
        await repository.recordDose(makeLog({ id: 'old', actualTime: '2026-06-01T08:00:00.000Z' }));
        await repository.recordDose(makeLog({ id: 'recent', actualTime: '2026-06-15T08:00:00.000Z' }));

        const recent = await repository.logsForMedicine('medicine-1', '2026-06-10T00:00:00.000Z');
        expect(recent.map((log) => log.id)).toEqual(['recent']);
      });

      it('returns the whole history when no cutoff is given', async () => {
        const { repository } = await freshRepository();
        await repository.recordDose(makeLog({ id: 'a', actualTime: '2026-06-01T08:00:00.000Z' }));
        await repository.recordDose(makeLog({ id: 'b', actualTime: '2026-06-15T08:00:00.000Z' }));

        expect(await repository.logsForMedicine('medicine-1')).toHaveLength(2);
      });

      it('finds a patient history within a window, for the Today view', async () => {
        const { repository } = await freshRepository();
        await repository.recordDose(makeLog({ id: 'yesterday', actualTime: '2026-06-14T08:00:00.000Z' }));
        await repository.recordDose(makeLog({ id: 'today', actualTime: '2026-06-15T08:00:00.000Z' }));

        const today = await repository.logsForPatientBetween(
          'patient-1',
          '2026-06-15T00:00:00.000Z',
          '2026-06-16T00:00:00.000Z',
        );
        expect(today.map((log) => log.id)).toEqual(['today']);
      });

      it('finds a patient\'s full log history regardless of actualTime, for occurrence matching', async () => {
        const { repository } = await freshRepository();
        await repository.recordDose(makeLog({ id: 'old', actualTime: '2026-01-01T08:00:00.000Z' }));
        await repository.recordDose(makeLog({ id: 'recent', actualTime: '2026-12-31T08:00:00.000Z' }));

        const all = await repository.logsForPatient('patient-1');
        expect(all.map((log) => log.id).sort()).toEqual(['old', 'recent']);
      });

      it('finds inventory adjustments by the log that produced them', async () => {
        const { repository } = await freshRepository();
        await repository.recordDose(makeLog({ id: 'a' }));
        await repository.recordDose(makeLog({ id: 'b', medicineId: 'other-medicine' }));

        expect(await repository.adjustmentsForMedicine('medicine-1')).toHaveLength(1);
      });
    });

    describe('outbox lifecycle', () => {
      it('drains oldest first', async () => {
        // A genuinely advancing clock, not the fixed one every other test uses — ties on
        // `createdAt` have no specified tie-break order in either IndexedDB or SQL, so this test
        // needs real time separation to mean anything backend-independently.
        const clock = manualClock(NOW);
        const { repository } = await freshRepository(clock);
        await repository.saveMedicine(makeMedicine({ id: 'b' }), 'CREATE');
        clock.advanceMinutes(1);
        await repository.saveMedicine(makeMedicine({ id: 'a' }), 'CREATE');

        expect((await repository.pendingSync()).map((entry) => entry.entityId)).toEqual(['b', 'a']);
      });

      it('removes an entry once the server accepts it', async () => {
        const { repository } = await freshRepository();
        await repository.saveMedicine(makeMedicine(), 'CREATE');
        const [entry] = await repository.pendingSync();

        await repository.markSynced(entry!.id!);
        expect(await repository.pendingSyncCount()).toBe(0);
      });

      it('records a failure without dropping the entry, so a stuck queue stays visible', async () => {
        const { repository } = await freshRepository();
        await repository.saveMedicine(makeMedicine(), 'CREATE');
        const [entry] = await repository.pendingSync();

        await repository.markSyncFailed(entry!.id!, 'network unreachable');
        await repository.markSyncFailed(entry!.id!, 'network unreachable');

        const [retried] = await repository.pendingSync();
        expect(retried).toMatchObject({ attempts: 2, lastError: 'network unreachable', lastAttemptAt: NOW });
      });

      it('ignores a failure report for an entry already synced away', async () => {
        const { repository } = await freshRepository();
        await expect(repository.markSyncFailed(999, 'gone')).resolves.toBeUndefined();
      });
    });

    describe('restoreBackup', () => {
      it('writes every record from the bundle', async () => {
        const { repository } = await freshRepository();
        await repository.restoreBackup(makeBundle());

        expect(await repository.getMedicine('medicine-1')).toBeDefined();
        expect(await repository.allSchedules()).toHaveLength(1);
        expect(await repository.logsForMedicine('medicine-1')).toHaveLength(1);
        expect(await repository.allInventoryItems()).toHaveLength(1);
        expect(await repository.adjustmentsForMedicine('medicine-1')).toHaveLength(1);
      });

      it('does not generate a second inventory adjustment for a restored dose', async () => {
        const { repository } = await freshRepository();
        await repository.restoreBackup(
          makeBundle({
            intakeLogs: [makeLog({ status: 'taken', quantityTaken: 2 })],
            inventoryAdjustments: [makeInventoryAdjustment({ delta: -2, relatedLogId: 'log-1' })],
          }),
        );

        expect(await repository.adjustmentsForMedicine('medicine-1')).toHaveLength(1);
      });

      it('preserves a log a correction superseded — the backup is the full history, not just the tip', async () => {
        const { repository } = await freshRepository();
        await repository.restoreBackup(
          makeBundle({ intakeLogs: [makeLog(), makeLog({ id: 'log-2', supersedesId: 'log-1' })] }),
        );

        expect(await repository.logsForMedicine('medicine-1')).toHaveLength(2);
      });

      it('queues an outbox entry for every restored record', async () => {
        const { repository } = await freshRepository();
        await repository.restoreBackup(makeBundle());

        expect(await repository.pendingSyncCount()).toBe(5);
      });

      it('upserts over an existing record with the same id rather than duplicating it', async () => {
        const { repository } = await freshRepository();
        await repository.saveMedicine(makeMedicine({ name: 'Old name' }), 'CREATE');

        await repository.restoreBackup(makeBundle({ medicines: [makeMedicine({ name: 'Restored name' })] }));

        expect((await repository.getMedicine('medicine-1'))?.name).toBe('Restored name');
        expect(await repository.activeMedicines()).toHaveLength(1);
      });

      it('restores an empty bundle without error', async () => {
        const { repository } = await freshRepository();
        await expect(
          repository.restoreBackup({ medicines: [], schedules: [], intakeLogs: [], inventoryItems: [], inventoryAdjustments: [] }),
        ).resolves.toBeUndefined();
      });
    });

    describe('snoozes — append-only, never overwritten (delta AD5)', () => {
      it('writes a snooze and its outbox row together', async () => {
        const { repository } = await freshRepository();
        await repository.recordSnooze(makeDoseSnooze());

        expect(await repository.snoozesForOccurrence(OCCURRENCE)).toHaveLength(1);
        const outbox = await repository.pendingSync();
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({ table: 'doseSnoozes', entityId: 'snooze-1', action: 'CREATE' });
      });

      it('accumulates rather than overwriting, so a bound is a row count', async () => {
        const { repository } = await freshRepository();
        await repository.recordSnooze(makeDoseSnooze({ id: 'snooze-1', count: 1 }));
        await repository.recordSnooze(makeDoseSnooze({ id: 'snooze-2', count: 2 }));
        await repository.recordSnooze(makeDoseSnooze({ id: 'snooze-3', count: 3 }));

        const stored = await repository.snoozesForOccurrence(OCCURRENCE);
        expect(stored).toHaveLength(3);
        expect(stored.map((snooze) => snooze.count).sort()).toEqual([1, 2, 3]);
      });

      it('keeps two devices’ concurrent snoozes of the same dose, discarding neither', async () => {
        // The whole reason this is a ledger and not a `snoozedUntil` field: LWW here would drop
        // one caregiver's decision silently.
        const { repository } = await freshRepository();
        await repository.recordSnooze(makeDoseSnooze({ id: 'from-mom', createdByDeviceId: 'device-1' }));
        await repository.recordSnooze(makeDoseSnooze({ id: 'from-dad', createdByDeviceId: 'device-2' }));

        expect(await repository.snoozesForOccurrence(OCCURRENCE)).toHaveLength(2);
      });

      it('scopes by occurrence — one dose’s snoozes never bound another’s', async () => {
        const { repository } = await freshRepository();
        await repository.recordSnooze(makeDoseSnooze({ id: 'a' }));
        await repository.recordSnooze(
          makeDoseSnooze({ id: 'b', occurrenceId: `schedule-2:${NOW}` }),
        );

        expect(await repository.snoozesForOccurrence(OCCURRENCE)).toHaveLength(1);
        expect(await repository.snoozesForOccurrence(`schedule-2:${NOW}`)).toHaveLength(1);
      });

      it('returns nothing for an occurrence that has never been snoozed', async () => {
        const { repository } = await freshRepository();
        expect(await repository.snoozesForOccurrence(OCCURRENCE)).toEqual([]);
      });

      it('recentSnoozes returns the window, excluding anything older', async () => {
        // The alarm engine reads a bounded window rather than the whole table: snoozes accumulate
        // forever, and one older than the horizon cannot still be deferring an alarm inside it.
        const { repository } = await freshRepository();
        await repository.recordSnooze(
          makeDoseSnooze({ id: 'old', createdAt: '2026-06-13T12:00:00.000Z' }),
        );
        await repository.recordSnooze(
          makeDoseSnooze({ id: 'recent', createdAt: '2026-06-15T11:00:00.000Z' }),
        );

        const recent = await repository.recentSnoozes('2026-06-15T00:00:00.000Z');
        expect(recent.map((snooze) => snooze.id)).toEqual(['recent']);
      });

      it('recentSnoozes spans occurrences, so one pass feeds a whole horizon', async () => {
        const { repository } = await freshRepository();
        await repository.recordSnooze(makeDoseSnooze({ id: 'a' }));
        await repository.recordSnooze(
          makeDoseSnooze({ id: 'b', occurrenceId: `schedule-2:${NOW}` }),
        );

        expect(await repository.recentSnoozes('2026-06-01T00:00:00.000Z')).toHaveLength(2);
      });
    });

    describe('clearAllData', () => {
      it('empties medicines, schedules, intake logs, and the inventory ledger', async () => {
        const { repository } = await freshRepository();
        await repository.restoreBackup(makeBundle());

        await repository.clearAllData();

        expect(await repository.activeMedicines()).toHaveLength(0);
        expect(await repository.allSchedules()).toHaveLength(0);
        expect(await repository.logsForMedicine('medicine-1')).toHaveLength(0);
        expect(await repository.allInventoryItems()).toHaveLength(0);
        expect(await repository.adjustmentsForMedicine('medicine-1')).toHaveLength(0);
      });

      it('leaves household settings and this device untouched — clears medical data, not the household connection', async () => {
        const { repository } = await freshRepository();
        await repository.saveHouseholdSettings({
          id: 'household',
          timeZone: 'Asia/Jerusalem',
          escalationAfterMinutes: 15,
          snoozeMinutes: 15,
          updatedAt: NOW,
          updatedByDeviceId: 'device-1',
          syncStatus: 'synced',
        });

        await repository.clearAllData();

        expect(await repository.getHouseholdSettings()).toBeDefined();
      });

      it('removes outbox rows for the cleared tables but not for other tables', async () => {
        const { repository } = await freshRepository();
        await repository.restoreBackup(makeBundle());
        await repository.saveHouseholdSettings({
          id: 'household',
          timeZone: 'Asia/Jerusalem',
          escalationAfterMinutes: 15,
          snoozeMinutes: 15,
          updatedAt: NOW,
          updatedByDeviceId: 'device-1',
          syncStatus: 'synced',
        });

        await repository.clearAllData();

        const outbox = await repository.pendingSync();
        expect(outbox).toHaveLength(1);
        expect(outbox[0]).toMatchObject({ table: 'householdSettings' });
      });

      it('is safe to call on an already-empty database', async () => {
        const { repository } = await freshRepository();
        await expect(repository.clearAllData()).resolves.toBeUndefined();
      });
    });
  });
}
