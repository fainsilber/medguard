import {
  adjustmentForLog,
  buildDoseAdjustment,
  buildManualAdjustment,
  buildReversalAdjustment,
  closeSchedule,
  reviseSchedule,
} from '@medguard/shared';
import type {
  Clock,
  DeviceId,
  HouseholdSettings,
  IdGenerator,
  IntakeLog,
  InventoryAdjustment,
  InventoryItem,
  LocalDate,
  ManualAdjustmentInput,
  Medicine,
  Schedule,
  ScheduleRevision,
  SyncAction,
  SyncOutboxEntry,
  SyncableTable,
  UserId,
  Uuid,
} from '@medguard/shared';
import type { MedGuardDB } from './schema.js';

/**
 * The only way application code touches the database.
 *
 * Its single reason to exist: **every mutation and its sync-outbox row are written in one
 * transaction.** A dose recorded but never queued would silently never reach the other
 * caregiver's phone; an outbox row for a dose that failed to save would sync a dose that never
 * happened. Both are invisible failures, so the atomicity is structural rather than a convention
 * callers are asked to remember.
 *
 * Time and identity are injected, never ambient — see packages/shared/src/clock.ts.
 */

export interface RepositoryContext {
  clock: Clock;
  ids: IdGenerator;
  userId: UserId;
  deviceId: DeviceId;
}

export class MedGuardRepository {
  constructor(
    private readonly db: MedGuardDB,
    private readonly context: RepositoryContext,
  ) {}

  // -------------------------------------------------------------------------
  // Outbox
  // -------------------------------------------------------------------------

  /**
   * Queues a mutation for upload. Must only ever be called from inside a transaction that also
   * writes the mutation itself.
   */
  private enqueue(
    table: SyncableTable,
    entityId: string,
    action: SyncAction,
    payload: unknown,
  ): Promise<number> {
    return this.db.syncOutbox.add({
      table,
      entityId,
      action,
      payload,
      createdAt: this.context.clock.nowIso(),
      attempts: 0,
    });
  }

  /** Oldest first — the queue drains in the order changes were made. */
  pendingSync(): Promise<SyncOutboxEntry[]> {
    return this.db.syncOutbox.orderBy('createdAt').toArray();
  }

  pendingSyncCount(): Promise<number> {
    return this.db.syncOutbox.count();
  }

  /** Called once the server has accepted an entry. */
  async markSynced(outboxId: number): Promise<void> {
    await this.db.syncOutbox.delete(outboxId);
  }

  /**
   * Records a failed upload attempt without dropping the entry.
   *
   * `attempts` and `lastError` exist so a stuck queue is visible in the UI rather than silently
   * retrying forever (safety invariant 6 — degradation is never invisible).
   */
  async markSyncFailed(outboxId: number, error: string): Promise<void> {
    const entry = await this.db.syncOutbox.get(outboxId);
    if (!entry) {
      return;
    }
    await this.db.syncOutbox.update(outboxId, {
      attempts: entry.attempts + 1,
      lastError: error,
      lastAttemptAt: this.context.clock.nowIso(),
    });
  }

  // -------------------------------------------------------------------------
  // Household settings
  // -------------------------------------------------------------------------

  async saveHouseholdSettings(
    settings: HouseholdSettings,
    action: SyncAction = 'UPDATE',
  ): Promise<void> {
    const stamped = this.stamp(settings);
    await this.db.transaction('rw', this.db.householdSettings, this.db.syncOutbox, async () => {
      await this.db.householdSettings.put(stamped);
      await this.enqueue('householdSettings', stamped.id, action, stamped);
    });
  }

  getHouseholdSettings(): Promise<HouseholdSettings | undefined> {
    return this.db.householdSettings.get('household');
  }

  // -------------------------------------------------------------------------
  // Medicines
  // -------------------------------------------------------------------------

  async saveMedicine(medicine: Medicine, action: SyncAction = 'UPDATE'): Promise<void> {
    const stamped = this.stamp(medicine);
    await this.db.transaction('rw', this.db.medicines, this.db.syncOutbox, async () => {
      await this.db.medicines.put(stamped);
      await this.enqueue('medicines', stamped.id, action, stamped);
    });
  }

  /**
   * Archives rather than deletes. Intake logs reference medicines forever, and deleting one
   * would orphan a patient's dosing history.
   */
  async archiveMedicine(medicineId: Uuid): Promise<void> {
    const medicine = await this.db.medicines.get(medicineId);
    if (!medicine) {
      throw new Error(`No such medicine: ${medicineId}`);
    }
    await this.saveMedicine({ ...medicine, archived: true });
  }

  activeMedicines(): Promise<Medicine[]> {
    return this.db.medicines.filter((medicine) => !medicine.archived).toArray();
  }

  getMedicine(medicineId: Uuid): Promise<Medicine | undefined> {
    return this.db.medicines.get(medicineId);
  }

  // -------------------------------------------------------------------------
  // Schedules
  // -------------------------------------------------------------------------

  async saveSchedule(schedule: Schedule, action: SyncAction = 'UPDATE'): Promise<void> {
    const stamped = this.stamp(schedule);
    await this.db.transaction('rw', this.db.schedules, this.db.syncOutbox, async () => {
      await this.db.schedules.put(stamped);
      await this.enqueue('schedules', stamped.id, action, stamped);
    });
  }

  /**
   * Edits a schedule by superseding it (PRD §2.2).
   *
   * Both versions are written together: a partial write would leave the household either with no
   * live schedule for a medicine, or with two overlapping ones — a missed dose or a doubled one.
   */
  async reviseSchedule(
    scheduleId: Uuid,
    changes: Parameters<typeof reviseSchedule>[1],
    effectiveFrom: LocalDate,
  ): Promise<ScheduleRevision> {
    const existing = await this.db.schedules.get(scheduleId);
    if (!existing) {
      throw new Error(`No such schedule: ${scheduleId}`);
    }

    const revision = reviseSchedule(existing, changes, effectiveFrom, {
      clock: this.context.clock,
      ids: this.context.ids,
      deviceId: this.context.deviceId,
    });

    await this.db.transaction('rw', this.db.schedules, this.db.syncOutbox, async () => {
      await this.db.schedules.bulkPut([revision.closed, revision.created]);
      await this.enqueue('schedules', revision.closed.id, 'UPDATE', revision.closed);
      await this.enqueue('schedules', revision.created.id, 'CREATE', revision.created);
    });

    return revision;
  }

  /** Stops a schedule with no replacement. */
  async closeSchedule(scheduleId: Uuid, effectiveFrom: LocalDate): Promise<Schedule> {
    const existing = await this.db.schedules.get(scheduleId);
    if (!existing) {
      throw new Error(`No such schedule: ${scheduleId}`);
    }

    const closed = closeSchedule(existing, effectiveFrom, {
      clock: this.context.clock,
      deviceId: this.context.deviceId,
    });

    await this.saveSchedule(closed);
    return closed;
  }

  schedulesForMedicine(medicineId: Uuid): Promise<Schedule[]> {
    return this.db.schedules.where('medicineId').equals(medicineId).toArray();
  }

  allSchedules(): Promise<Schedule[]> {
    return this.db.schedules.toArray();
  }

  // -------------------------------------------------------------------------
  // Intake logs
  // -------------------------------------------------------------------------

  /**
   * Records an administered dose and decrements stock, atomically.
   *
   * Four writes — the log, the ledger entry, and an outbox row for each — in one transaction.
   * Splitting them would allow a dose that decremented stock but was never recorded, or stock
   * that never moved for a dose that was.
   *
   * Does not itself evaluate the safety guards: it records what a human decided (safety
   * invariant 2). The caller assesses first and attaches an `override` when a block was
   * deliberately bypassed.
   */
  async recordDose(log: IntakeLog): Promise<{ log: IntakeLog; adjustment?: InventoryAdjustment }> {
    // Stock only moves for a dose actually given — skipped and missed doses consume nothing.
    const adjustment =
      log.status === 'taken' ? buildDoseAdjustment(log, this.adjustmentContext()) : undefined;

    await this.db.transaction(
      'rw',
      this.db.intakeLogs,
      this.db.inventoryAdjustments,
      this.db.syncOutbox,
      async () => {
        await this.db.intakeLogs.put(log);
        await this.enqueue('intakeLogs', log.id, 'CREATE', log);

        if (adjustment) {
          await this.db.inventoryAdjustments.put(adjustment);
          await this.enqueue('inventoryAdjustments', adjustment.id, 'CREATE', adjustment);
        }
      },
    );

    return { log, ...(adjustment ? { adjustment } : {}) };
  }

  /**
   * Corrects an earlier dose by appending a replacement, never by editing it (safety invariant 1).
   *
   * The original log stays visible in history, and its stock movement is reversed by an
   * offsetting ledger entry rather than by deleting the original — a ledger you can delete from
   * is not an audit trail.
   */
  async correctDose(
    originalLogId: Uuid,
    correction: Omit<IntakeLog, 'supersedesId'>,
  ): Promise<IntakeLog> {
    const original = await this.db.intakeLogs.get(originalLogId);
    if (!original) {
      throw new Error(`No such intake log: ${originalLogId}`);
    }

    const corrected: IntakeLog = { ...correction, supersedesId: originalLogId };

    const originalAdjustment = adjustmentForLog(
      await this.db.inventoryAdjustments.where('relatedLogId').equals(originalLogId).toArray(),
      originalLogId,
    );
    const reversal = originalAdjustment
      ? buildReversalAdjustment(originalAdjustment, this.adjustmentContext())
      : undefined;
    const replacement =
      corrected.status === 'taken'
        ? buildDoseAdjustment(corrected, this.adjustmentContext())
        : undefined;

    await this.db.transaction(
      'rw',
      this.db.intakeLogs,
      this.db.inventoryAdjustments,
      this.db.syncOutbox,
      async () => {
        await this.db.intakeLogs.put(corrected);
        await this.enqueue('intakeLogs', corrected.id, 'CREATE', corrected);

        for (const entry of [reversal, replacement]) {
          if (entry) {
            await this.db.inventoryAdjustments.put(entry);
            await this.enqueue('inventoryAdjustments', entry.id, 'CREATE', entry);
          }
        }
      },
    );

    return corrected;
  }

  /**
   * The full history for one medicine, using the `[medicineId+actualTime]` compound index so the
   * rolling-cap check stays fast as history grows.
   */
  logsForMedicine(medicineId: Uuid, sinceIso?: string): Promise<IntakeLog[]> {
    if (sinceIso === undefined) {
      return this.db.intakeLogs.where('medicineId').equals(medicineId).toArray();
    }
    return this.db.intakeLogs
      .where('[medicineId+actualTime]')
      .between([medicineId, sinceIso], [medicineId, '￿'])
      .toArray();
  }

  /** The Today view's query, using the `[patientId+actualTime]` compound index. */
  logsForPatientBetween(patientId: Uuid, fromIso: string, toIso: string): Promise<IntakeLog[]> {
    return this.db.intakeLogs
      .where('[patientId+actualTime]')
      .between([patientId, fromIso], [patientId, toIso])
      .toArray();
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  async adjustInventory(input: ManualAdjustmentInput): Promise<InventoryAdjustment> {
    const adjustment = buildManualAdjustment(input, this.adjustmentContext());

    await this.db.transaction(
      'rw',
      this.db.inventoryAdjustments,
      this.db.syncOutbox,
      async () => {
        await this.db.inventoryAdjustments.put(adjustment);
        await this.enqueue('inventoryAdjustments', adjustment.id, 'CREATE', adjustment);
      },
    );

    return adjustment;
  }

  adjustmentsForMedicine(medicineId: Uuid): Promise<InventoryAdjustment[]> {
    return this.db.inventoryAdjustments.where('medicineId').equals(medicineId).toArray();
  }

  /**
   * Creates or updates the stock-tracking config (unit name, refill threshold) for a medicine.
   * Separate from `adjustInventory`: this describes how to track stock, not a change in the
   * quantity itself.
   */
  async saveInventoryItem(item: InventoryItem, action: SyncAction = 'UPDATE'): Promise<void> {
    const stamped = this.stamp(item);
    await this.db.transaction('rw', this.db.inventoryItems, this.db.syncOutbox, async () => {
      await this.db.inventoryItems.put(stamped);
      await this.enqueue('inventoryItems', stamped.id, action, stamped);
    });
  }

  getInventoryItem(medicineId: Uuid): Promise<InventoryItem | undefined> {
    return this.db.inventoryItems.where('medicineId').equals(medicineId).first();
  }

  allInventoryItems(): Promise<InventoryItem[]> {
    return this.db.inventoryItems.toArray();
  }

  // -------------------------------------------------------------------------

  private adjustmentContext() {
    return {
      clock: this.context.clock,
      ids: this.context.ids,
      userId: this.context.userId,
      deviceId: this.context.deviceId,
    };
  }

  /** Marks a record as locally modified and not yet acknowledged by the server. */
  private stamp<T extends { updatedAt: string; updatedByDeviceId: string; syncStatus: string }>(
    record: T,
  ): T {
    return {
      ...record,
      updatedAt: this.context.clock.nowIso(),
      updatedByDeviceId: this.context.deviceId,
      syncStatus: 'pending',
    };
  }
}
