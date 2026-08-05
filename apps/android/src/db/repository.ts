import { buildDoseAdjustment, buildManualAdjustment } from '@medguard/shared';
import type {
  Clock,
  DeviceId,
  HouseholdSettings,
  IdGenerator,
  IntakeLog,
  InventoryAdjustment,
  InventoryItem,
  ManualAdjustmentInput,
  Medicine,
  Schedule,
  Syncable,
  SyncAction,
  SyncOutboxEntry,
  SyncableTable,
  UserId,
  Uuid,
} from '@medguard/shared';
import type { AndroidMedGuardDB } from './schema.js';

/**
 * The only way Android application code touches the database.
 *
 * Its single reason to exist is the same as the web repository's: **every mutation and its
 * sync-outbox row are written in one transaction.** A dose recorded but never queued would
 * silently never reach the other caregiver's phone; an outbox row for a dose that failed to
 * save would sync a dose that never happened. Both fail invisibly, so the atomicity is
 * structural rather than a convention callers are asked to remember.
 *
 * Time and identity are injected, never ambient — see packages/shared/src/clock.ts.
 *
 * Every stock movement is built by `packages/shared/src/inventory.ts` rather than computed
 * here, so the append-only ledger has exactly one implementation across both clients. This
 * class is a deliberately small subset of `apps/web/src/db/repository.ts` covering only what
 * the Android screens do; the two should become one shared package (see README.md).
 */

export interface RepositoryContext {
  clock: Clock;
  ids: IdGenerator;
  userId: UserId;
  deviceId: DeviceId;
}

export class AndroidRepository {
  constructor(
    private readonly db: AndroidMedGuardDB,
    private readonly context: RepositoryContext,
  ) {}

  /** Attribution and sync state, stamped at write time so no caller can forget them. */
  private stamp<T extends Syncable>(record: T): T {
    return {
      ...record,
      updatedAt: this.context.clock.nowIso(),
      updatedByDeviceId: this.context.deviceId,
      syncStatus: 'pending',
    };
  }

  private adjustmentContext() {
    const { clock, ids, userId, deviceId } = this.context;
    return { clock, ids, userId, deviceId };
  }

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

  // -------------------------------------------------------------------------
  // Medicines and schedules
  // -------------------------------------------------------------------------

  async saveMedicine(medicine: Medicine, action: SyncAction = 'UPDATE'): Promise<void> {
    const stamped = this.stamp(medicine);
    await this.db.transaction('rw', this.db.medicines, this.db.syncOutbox, async () => {
      await this.db.medicines.put(stamped);
      await this.enqueue('medicines', stamped.id, action, stamped);
    });
  }

  async saveSchedule(schedule: Schedule, action: SyncAction = 'UPDATE'): Promise<void> {
    const stamped = this.stamp(schedule);
    await this.db.transaction('rw', this.db.schedules, this.db.syncOutbox, async () => {
      await this.db.schedules.put(stamped);
      await this.enqueue('schedules', stamped.id, action, stamped);
    });
  }

  // -------------------------------------------------------------------------
  // Doses
  // -------------------------------------------------------------------------

  /**
   * Appends an intake log and, for a dose actually given, its stock decrement.
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

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  /**
   * A caregiver-entered stock change. Appends a ledger entry — it never writes a running total,
   * because two caregivers refilling offline would each overwrite the other's count under
   * Last-Write-Wins and silently lose one of the refills.
   */
  async adjustInventory(input: ManualAdjustmentInput): Promise<InventoryAdjustment> {
    const adjustment = buildManualAdjustment(input, this.adjustmentContext());

    await this.db.transaction('rw', this.db.inventoryAdjustments, this.db.syncOutbox, async () => {
      await this.db.inventoryAdjustments.put(adjustment);
      await this.enqueue('inventoryAdjustments', adjustment.id, 'CREATE', adjustment);
    });

    return adjustment;
  }

  /**
   * Creates or updates how a medicine's stock is tracked (unit name, refill threshold).
   * Separate from `adjustInventory`: this describes the tracking, not a change in quantity.
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
}
