import {
  adjustmentForLog,
  buildDoseAdjustment,
  buildManualAdjustment,
  buildReversalAdjustment,
  closeSchedule,
  formatLocalDate,
  medicinePatientId,
  reviseSchedule,
} from '@medguard/shared';
import type {
  BackupBundle,
  Clock,
  DeviceId,
  DoseSnooze,
  HouseholdSettings,
  IdGenerator,
  IntakeLog,
  InventoryAdjustment,
  InventoryItem,
  IsoInstant,
  LocalDate,
  ManualAdjustmentInput,
  Medicine,
  MedicinePatient,
  Patient,
  Schedule,
  ScheduleRevision,
  ShabbatConfig,
  ShabbatWindow,
  SyncAction,
  SyncOutboxEntry,
  SyncableTable,
  UserId,
  Uuid,
} from '@medguard/shared';
import type { Store, StoreTransaction } from './types.js';

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
 *
 * Storage-agnostic since Sprint A1 (docs/android-client-plan.md, "Storage and the sync port"):
 * this is the exact class `apps/web/src/db/repository.ts` used to be, now driven through the
 * `Store` port so `apps/web` (Dexie) and `apps/android` (SQLite) share one implementation rather
 * than two copies of the append-only-ledger rules.
 */

export interface RepositoryContext {
  clock: Clock;
  ids: IdGenerator;
  userId: UserId;
  deviceId: DeviceId;
}

/**
 * One dose from the Motzei Shabbat sheet, as answered.
 *
 * `supersedesLogId` is absent when the Durable Object never recorded a `pending_shabbat` log for
 * the dose — the answer is then the first thing said about it, rather than a correction of the
 * server's placeholder.
 */
export interface ReconciliationEntry {
  log: Omit<IntakeLog, 'supersedesId'>;
  supersedesLogId?: Uuid;
}

/** Sorts after every realistic ISO-8601 timestamp — the open upper bound for a "since X" range scan. */
const RANGE_SENTINEL_MAX = '￿';

export class MedGuardRepository {
  constructor(
    private readonly store: Store,
    private readonly context: RepositoryContext,
  ) {}

  /**
   * The injected clock's current instant.
   *
   * Exposed so callers that need to stamp something *alongside* a repository write — the sync
   * engine's `lastSyncedAt`, for one — use the same clock the outbox rows are stamped with,
   * rather than reaching for an ambient `Date.now()` that a test could not control and the
   * no-ambient-time lint rule would reject anyway.
   */
  now(): IsoInstant {
    return this.context.clock.nowIso();
  }

  // -------------------------------------------------------------------------
  // Outbox
  // -------------------------------------------------------------------------

  /**
   * Queues a mutation for upload. Must only ever be called with the `tx` of a transaction that
   * also writes the mutation itself.
   */
  private enqueue(
    tx: StoreTransaction,
    table: SyncableTable,
    entityId: string,
    action: SyncAction,
    payload: unknown,
  ): Promise<number> {
    return tx.append<SyncOutboxEntry>('syncOutbox', {
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
    return this.store.transaction(['syncOutbox'], (tx) =>
      tx.queryIndex<SyncOutboxEntry>('syncOutbox', { kind: 'all', orderBy: 'createdAt' }),
    );
  }

  pendingSyncCount(): Promise<number> {
    return this.store.transaction(['syncOutbox'], (tx) => tx.count('syncOutbox'));
  }

  /** Called once the server has accepted an entry. */
  async markSynced(outboxId: number): Promise<void> {
    await this.store.transaction(['syncOutbox'], (tx) => tx.delete('syncOutbox', outboxId));
  }

  /**
   * Records a failed upload attempt without dropping the entry.
   *
   * `attempts` and `lastError` exist so a stuck queue is visible in the UI rather than silently
   * retrying forever (safety invariant 6 — degradation is never invisible).
   */
  async markSyncFailed(outboxId: number, error: string): Promise<void> {
    await this.store.transaction(['syncOutbox'], async (tx) => {
      const entry = await tx.get<SyncOutboxEntry>('syncOutbox', outboxId);
      if (!entry) {
        return;
      }
      await tx.update<SyncOutboxEntry>('syncOutbox', outboxId, {
        attempts: entry.attempts + 1,
        lastError: error,
        lastAttemptAt: this.context.clock.nowIso(),
      });
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
    await this.store.transaction(['householdSettings', 'syncOutbox'], async (tx) => {
      await tx.put('householdSettings', stamped);
      await this.enqueue(tx, 'householdSettings', stamped.id, action, stamped);
    });
  }

  getHouseholdSettings(): Promise<HouseholdSettings | undefined> {
    return this.store.transaction(['householdSettings'], (tx) =>
      tx.get<HouseholdSettings>('householdSettings', 'household'),
    );
  }

  // -------------------------------------------------------------------------
  // Patients
  // -------------------------------------------------------------------------

  async savePatient(patient: Patient, action: SyncAction = 'UPDATE'): Promise<void> {
    const stamped = this.stamp(patient);
    await this.store.transaction(['patients', 'syncOutbox'], async (tx) => {
      await tx.put('patients', stamped);
      await this.enqueue(tx, 'patients', stamped.id, action, stamped);
    });
  }

  /**
   * Archives rather than deletes. Medicines, schedules and intake logs reference a patient
   * forever, and deleting one would orphan that history (safety invariant 1) the same way
   * deleting a medicine would.
   */
  async archivePatient(patientId: Uuid): Promise<void> {
    const patient = await this.getPatient(patientId);
    if (!patient) {
      throw new Error(`No such patient: ${patientId}`);
    }
    await this.savePatient({ ...patient, archived: true });
  }

  getPatient(patientId: Uuid): Promise<Patient | undefined> {
    return this.store.transaction(['patients'], (tx) => tx.get<Patient>('patients', patientId));
  }

  /** Every patient, archived or not — for a "show archived" toggle over `activePatients()`. */
  allPatients(): Promise<Patient[]> {
    return this.store.transaction(['patients'], (tx) => tx.getAll<Patient>('patients'));
  }

  async activePatients(): Promise<Patient[]> {
    const all = await this.allPatients();
    return all.filter((patient) => !patient.archived);
  }

  // -------------------------------------------------------------------------
  // Medicine ↔ patient assignments
  // -------------------------------------------------------------------------

  /**
   * Assigns a medicine to a patient — private if it's the only assignment, shared once there is
   * more than one. Idempotent: `id` is deterministic (`medicineId:patientId`), so assigning the
   * same pair again (including from two devices offline at once) converges on one row rather than
   * duplicating it.
   */
  async assignMedicine(medicineId: Uuid, patientId: Uuid): Promise<MedicinePatient> {
    const existing = await this.store.transaction(['medicinePatients'], (tx) =>
      tx.get<MedicinePatient>('medicinePatients', medicinePatientId(medicineId, patientId)),
    );
    const assignment = this.stamp<MedicinePatient>({
      id: medicinePatientId(medicineId, patientId),
      medicineId,
      patientId,
      active: true,
      updatedAt: this.context.clock.nowIso(),
      updatedByDeviceId: this.context.deviceId,
      syncStatus: 'pending',
    });

    await this.store.transaction(['medicinePatients', 'syncOutbox'], async (tx) => {
      await tx.put('medicinePatients', assignment);
      await this.enqueue(
        tx,
        'medicinePatients',
        assignment.id,
        existing ? 'UPDATE' : 'CREATE',
        assignment,
      );
    });

    return assignment;
  }

  /**
   * Un-assigns a medicine from a patient. A soft delete — `active: false` — for the same reason a
   * medicine archives rather than disappears: an intake log logged while the assignment existed
   * must still be able to resolve it later, even after a caregiver removes it. A no-op if the pair
   * was never assigned.
   */
  async unassignMedicine(medicineId: Uuid, patientId: Uuid): Promise<void> {
    const existing = await this.store.transaction(['medicinePatients'], (tx) =>
      tx.get<MedicinePatient>('medicinePatients', medicinePatientId(medicineId, patientId)),
    );
    if (!existing || !existing.active) {
      return;
    }
    const stamped = this.stamp<MedicinePatient>({ ...existing, active: false });
    await this.store.transaction(['medicinePatients', 'syncOutbox'], async (tx) => {
      await tx.put('medicinePatients', stamped);
      await this.enqueue(tx, 'medicinePatients', stamped.id, 'UPDATE', stamped);
    });
  }

  /** Every active assignment for one medicine — which patients currently take it. */
  async medicinePatientsFor(medicineId: Uuid): Promise<MedicinePatient[]> {
    const all = await this.store.transaction(['medicinePatients'], (tx) =>
      tx.queryIndex<MedicinePatient>('medicinePatients', {
        kind: 'equals',
        fields: ['medicineId'],
        values: [medicineId],
      }),
    );
    return all.filter((assignment) => assignment.active);
  }

  /** The patients currently assigned to one medicine, resolved from `medicinePatientsFor`. */
  async patientsForMedicine(medicineId: Uuid): Promise<Patient[]> {
    const assignments = await this.medicinePatientsFor(medicineId);
    const patients = await Promise.all(assignments.map((a) => this.getPatient(a.patientId)));
    return patients.filter((p): p is Patient => p !== undefined);
  }

  // -------------------------------------------------------------------------
  // Shabbat (Sprint A5)
  // -------------------------------------------------------------------------

  /**
   * The Shabbat configuration for one patient — coordinates, candle-lighting offset, Havdalah
   * rule, Israel/diaspora, chime length. One row per patient.
   *
   * `patientId` is optional only for callers not yet updated to pass one, in which case the first
   * row is returned — the pre-multi-patient behavior, kept so this compiles for every existing
   * caller rather than breaking them, but not a real answer once a household has more than one
   * patient's config. `undefined` means Shabbat has never been configured for that patient, which
   * is not the same as automation being off: the server publishes no windows without one, and
   * nothing enters Shabbat mode.
   */
  async getShabbatConfig(patientId?: Uuid): Promise<ShabbatConfig | undefined> {
    const all = await this.store.transaction(['shabbatConfig'], (tx) =>
      tx.getAll<ShabbatConfig>('shabbatConfig'),
    );
    if (patientId === undefined) {
      return all[0];
    }
    return all.find((config) => config.patientId === patientId);
  }

  async saveShabbatConfig(config: ShabbatConfig, action: SyncAction = 'UPDATE'): Promise<void> {
    const stamped = this.stamp(config);
    await this.store.transaction(['shabbatConfig', 'syncOutbox'], async (tx) => {
      await tx.put('shabbatConfig', stamped);
      await this.enqueue(tx, 'shabbatConfig', stamped.id, action, stamped);
    });
  }

  /**
   * Every Shabbat window this device holds, optionally narrowed to one patient.
   *
   * Read in full rather than by range: the server publishes a rolling 90 days, which is a few
   * dozen rows per patient, and every caller — the alarm horizon, the verification screen, the
   * in-mode banner — wants a different slice of them. Filtering by time is
   * `packages/shared/src/shabbat.ts`'s job, so that the phone and the Durable Object apply the
   * same boundary rule to the same records; filtering by patient happens here because it's a
   * property of which rows are even relevant, not of the boundary rule itself.
   *
   * There is no `saveShabbatWindow`, deliberately: windows are server-authored (the sync push
   * route rejects a client-written one), and this device only ever receives them through a pull.
   */
  async allShabbatWindows(patientId?: Uuid): Promise<ShabbatWindow[]> {
    const all = await this.store.transaction(['shabbatWindows'], (tx) =>
      tx.getAll<ShabbatWindow>('shabbatWindows'),
    );
    return patientId === undefined ? all : all.filter((window) => window.patientId === patientId);
  }

  // -------------------------------------------------------------------------
  // Medicines
  // -------------------------------------------------------------------------

  /**
   * Saving a medicine as as-needed also closes any schedule still active for it. Without this, a
   * medicine switched from scheduled to as-needed keeps producing occurrences from its old
   * schedule forever — `asNeeded` alone doesn't stop `expandSchedules` from a schedule row that's
   * still `active: true`. Mirrors the "Stop" action `ScheduleList` already offers, just applied
   * automatically at the point a caregiver declares the medicine as-needed instead of requiring a
   * separate manual step.
   */
  async saveMedicine(medicine: Medicine, action: SyncAction = 'UPDATE'): Promise<void> {
    const stamped = this.stamp(medicine);

    const activeSchedules = medicine.asNeeded
      ? (await this.schedulesForMedicine(medicine.id)).filter((schedule) => schedule.active)
      : [];
    const closedSchedules =
      activeSchedules.length > 0 ? await this.closeSchedulesForAsNeeded(activeSchedules) : [];

    await this.store.transaction(['medicines', 'schedules', 'syncOutbox'], async (tx) => {
      await tx.put('medicines', stamped);
      await this.enqueue(tx, 'medicines', stamped.id, action, stamped);
      for (const closed of closedSchedules) {
        await tx.put('schedules', closed);
        await this.enqueue(tx, 'schedules', closed.id, 'UPDATE', closed);
      }
    });
  }

  private async closeSchedulesForAsNeeded(schedules: Schedule[]): Promise<Schedule[]> {
    const settings = await this.getHouseholdSettings();
    const today = formatLocalDate(settings?.timeZone ?? 'UTC', this.context.clock.nowMs());
    return schedules.map((schedule) =>
      closeSchedule(schedule, today, {
        clock: this.context.clock,
        deviceId: this.context.deviceId,
      }),
    );
  }

  /**
   * Archives rather than deletes. Intake logs reference medicines forever, and deleting one
   * would orphan a patient's dosing history.
   */
  async archiveMedicine(medicineId: Uuid): Promise<void> {
    const medicine = await this.getMedicine(medicineId);
    if (!medicine) {
      throw new Error(`No such medicine: ${medicineId}`);
    }
    await this.saveMedicine({ ...medicine, archived: true });
  }

  async activeMedicines(patientId?: Uuid): Promise<Medicine[]> {
    const all = await this.allMedicines(patientId);
    return all.filter((medicine) => !medicine.archived);
  }

  /**
   * Every medicine, archived or not — for a "show archived" toggle over `activeMedicines()`.
   *
   * Narrowed to one patient via `medicinePatients`, not `Medicine.patientId` — that field is
   * vestigial (see its doc comment in `@medguard/shared`'s types.ts); a medicine assigned to
   * several patients, or reassigned since it was created, only resolves correctly through the
   * join table. Omitting `patientId` returns every medicine in the household, assigned or not.
   */
  async allMedicines(patientId?: Uuid): Promise<Medicine[]> {
    const all = await this.store.transaction(['medicines'], (tx) =>
      tx.getAll<Medicine>('medicines'),
    );
    if (patientId === undefined) {
      return all;
    }
    const assigned = await this.store.transaction(['medicinePatients'], (tx) =>
      tx.queryIndex<MedicinePatient>('medicinePatients', {
        kind: 'equals',
        fields: ['patientId'],
        values: [patientId],
      }),
    );
    const assignedMedicineIds = new Set(
      assigned.filter((assignment) => assignment.active).map((assignment) => assignment.medicineId),
    );
    return all.filter((medicine) => assignedMedicineIds.has(medicine.id));
  }

  getMedicine(medicineId: Uuid): Promise<Medicine | undefined> {
    return this.store.transaction(['medicines'], (tx) => tx.get<Medicine>('medicines', medicineId));
  }

  // -------------------------------------------------------------------------
  // Schedules
  // -------------------------------------------------------------------------

  async saveSchedule(schedule: Schedule, action: SyncAction = 'UPDATE'): Promise<void> {
    const stamped = this.stamp(schedule);
    await this.store.transaction(['schedules', 'syncOutbox'], async (tx) => {
      await tx.put('schedules', stamped);
      await this.enqueue(tx, 'schedules', stamped.id, action, stamped);
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
    const existing = await this.store.transaction(['schedules'], (tx) =>
      tx.get<Schedule>('schedules', scheduleId),
    );
    if (!existing) {
      throw new Error(`No such schedule: ${scheduleId}`);
    }

    const revision = reviseSchedule(existing, changes, effectiveFrom, {
      clock: this.context.clock,
      ids: this.context.ids,
      deviceId: this.context.deviceId,
    });

    await this.store.transaction(['schedules', 'syncOutbox'], async (tx) => {
      await tx.bulkPut('schedules', [revision.closed, revision.created]);
      await this.enqueue(tx, 'schedules', revision.closed.id, 'UPDATE', revision.closed);
      await this.enqueue(tx, 'schedules', revision.created.id, 'CREATE', revision.created);
    });

    return revision;
  }

  /** Stops a schedule with no replacement. */
  async closeSchedule(scheduleId: Uuid, effectiveFrom: LocalDate): Promise<Schedule> {
    const existing = await this.store.transaction(['schedules'], (tx) =>
      tx.get<Schedule>('schedules', scheduleId),
    );
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
    return this.store.transaction(['schedules'], (tx) =>
      tx.queryIndex<Schedule>('schedules', {
        kind: 'equals',
        fields: ['medicineId'],
        values: [medicineId],
      }),
    );
  }

  /** Every schedule in the household, optionally narrowed to one patient. Unlike `Medicine`,
   * `Schedule.patientId` is not vestigial — a schedule always belongs to exactly one patient, even
   * when it's for a medicine several patients share (one schedule per patient, per medicine). */
  async allSchedules(patientId?: Uuid): Promise<Schedule[]> {
    const all = await this.store.transaction(['schedules'], (tx) =>
      tx.getAll<Schedule>('schedules'),
    );
    return patientId === undefined
      ? all
      : all.filter((schedule) => schedule.patientId === patientId);
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

    await this.store.transaction(
      ['intakeLogs', 'inventoryAdjustments', 'syncOutbox'],
      async (tx) => {
        await tx.put('intakeLogs', log);
        await this.enqueue(tx, 'intakeLogs', log.id, 'CREATE', log);

        if (adjustment) {
          await tx.put('inventoryAdjustments', adjustment);
          await this.enqueue(tx, 'inventoryAdjustments', adjustment.id, 'CREATE', adjustment);
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
    const original = await this.store.transaction(['intakeLogs'], (tx) =>
      tx.get<IntakeLog>('intakeLogs', originalLogId),
    );
    if (!original) {
      throw new Error(`No such intake log: ${originalLogId}`);
    }

    const corrected: IntakeLog = { ...correction, supersedesId: originalLogId };

    const existingAdjustments = await this.store.transaction(['inventoryAdjustments'], (tx) =>
      tx.queryIndex<InventoryAdjustment>('inventoryAdjustments', {
        kind: 'equals',
        fields: ['relatedLogId'],
        values: [originalLogId],
      }),
    );
    const originalAdjustment = adjustmentForLog(existingAdjustments, originalLogId);
    const reversal = originalAdjustment
      ? buildReversalAdjustment(originalAdjustment, this.adjustmentContext())
      : undefined;
    const replacement =
      corrected.status === 'taken'
        ? buildDoseAdjustment(corrected, this.adjustmentContext())
        : undefined;

    await this.store.transaction(
      ['intakeLogs', 'inventoryAdjustments', 'syncOutbox'],
      async (tx) => {
        await tx.put('intakeLogs', corrected);
        await this.enqueue(tx, 'intakeLogs', corrected.id, 'CREATE', corrected);

        for (const entry of [reversal, replacement]) {
          if (entry) {
            await tx.put('inventoryAdjustments', entry);
            await this.enqueue(tx, 'inventoryAdjustments', entry.id, 'CREATE', entry);
          }
        }
      },
    );

    return corrected;
  }

  /**
   * Settles a whole Motzei Shabbat sheet in one transaction (Sprint A5 phase 2).
   *
   * Each entry is one dose from the window that just ended. Where the Durable Object recorded a
   * `pending_shabbat` log, the answer *supersedes* it — appended, never edited (safety invariant
   * 1) — and where no log exists at all (the server never woke, or the household was offline for
   * the whole of Shabbat), the answer is the dose's first log.
   *
   * One transaction for the entire sheet, not one per dose. A caregiver taps "all given as
   * scheduled" once; a crash halfway through a loop of separate writes would leave a household
   * with some doses recorded, some not, and no way to tell which — the same reasoning that puts a
   * dose and its stock movement in one transaction, applied to the whole batch.
   *
   * No stock is reversed: a `pending_shabbat` log records that an alert fired, and it never moved
   * any (`recordDose` only builds an adjustment for a `taken` log), so the only ledger entries
   * here are the new decrements for doses actually given.
   */
  async reconcileShabbatDoses(entries: readonly ReconciliationEntry[]): Promise<IntakeLog[]> {
    const written: { log: IntakeLog; adjustment?: InventoryAdjustment }[] = entries.map((entry) => {
      const log: IntakeLog = {
        ...entry.log,
        ...(entry.supersedesLogId !== undefined ? { supersedesId: entry.supersedesLogId } : {}),
      };
      const adjustment =
        log.status === 'taken' ? buildDoseAdjustment(log, this.adjustmentContext()) : undefined;
      return { log, ...(adjustment ? { adjustment } : {}) };
    });

    await this.store.transaction(
      ['intakeLogs', 'inventoryAdjustments', 'syncOutbox'],
      async (tx) => {
        for (const { log, adjustment } of written) {
          await tx.put('intakeLogs', log);
          await this.enqueue(tx, 'intakeLogs', log.id, 'CREATE', log);

          if (adjustment) {
            await tx.put('inventoryAdjustments', adjustment);
            await this.enqueue(tx, 'inventoryAdjustments', adjustment.id, 'CREATE', adjustment);
          }
        }
      },
    );

    return written.map((entry) => entry.log);
  }

  /**
   * Removes a locally-written log the server refused, with its stock movement and their queued
   * uploads.
   *
   * **The only thing in this system that deletes an intake log**, and it is deliberately narrow:
   * the only caller is the sync engine, and only for a record the server authoritatively rejected
   * — today, a Motzei reconciliation that lost a race to the other caregiver (Sprint A5 phase 2).
   *
   * That is not a hole in the append-only rule. The rule protects the household's medical record;
   * a log the server never accepted was never in it. Leaving it behind is the actual harm: this
   * one device would show a dose the record does not have, and would decrement its own stock for
   * it, disagreeing with every other device forever about whether a child was medicated.
   */
  async discardLocalLog(logId: Uuid): Promise<void> {
    const adjustments = await this.store.transaction(['inventoryAdjustments'], (tx) =>
      tx.queryIndex<InventoryAdjustment>('inventoryAdjustments', {
        kind: 'equals',
        fields: ['relatedLogId'],
        values: [logId],
      }),
    );

    const pending = await this.pendingSync();
    const orphanedOutbox = pending.filter(
      (entry) =>
        (entry.table === 'intakeLogs' && entry.entityId === logId) ||
        (entry.table === 'inventoryAdjustments' &&
          adjustments.some((adjustment) => adjustment.id === entry.entityId)),
    );

    await this.store.transaction(
      ['intakeLogs', 'inventoryAdjustments', 'syncOutbox'],
      async (tx) => {
        await tx.delete('intakeLogs', logId);
        for (const adjustment of adjustments) {
          await tx.delete('inventoryAdjustments', adjustment.id);
        }
        for (const entry of orphanedOutbox) {
          // `id` is optional on the type only because it is absent before insertion; every row
          // `pendingSync()` returns has been persisted. Same assertion the sync engine makes.
          await tx.delete('syncOutbox', entry.id!);
        }
      },
    );
  }

  /**
   * The full history for one medicine, using the `[medicineId+actualTime]` compound index so the
   * rolling-cap check stays fast as history grows.
   */
  logsForMedicine(medicineId: Uuid, sinceIso?: string): Promise<IntakeLog[]> {
    return this.store.transaction(['intakeLogs'], (tx) =>
      sinceIso === undefined
        ? tx.queryIndex<IntakeLog>('intakeLogs', {
            kind: 'equals',
            fields: ['medicineId'],
            values: [medicineId],
          })
        : tx.queryIndex<IntakeLog>('intakeLogs', {
            kind: 'range',
            fields: ['medicineId', 'actualTime'],
            prefix: [medicineId],
            lower: sinceIso,
            upper: RANGE_SENTINEL_MAX,
          }),
    );
  }

  /**
   * Every log for one patient, unfiltered by time. `findLogForOccurrence` (`@medguard/shared`)
   * matches a scheduled occurrence to its log by `(scheduleId, scheduledTime)`, not by
   * `actualTime` — a correction can carry an `actualTime` far outside the day it corrects, so a
   * Today-style view needs the full set, not an `actualTime`-bounded slice like
   * `logsForPatientBetween`.
   */
  logsForPatient(patientId: Uuid): Promise<IntakeLog[]> {
    return this.store.transaction(['intakeLogs'], (tx) =>
      tx.queryIndex<IntakeLog>('intakeLogs', {
        kind: 'equals',
        fields: ['patientId'],
        values: [patientId],
      }),
    );
  }

  /**
   * The PRN cooldown/cap query: one patient's history of one medicine, using the
   * `[medicineId+patientId+actualTime]` index so it stays fast as history grows.
   *
   * Scoped by both fields because a medicine shared by several patients has one cooldown/cap
   * *limit*, but each patient's doses are counted against it independently — see `AssessDoseInput`
   * in `@medguard/shared`'s safety.ts. `logsForMedicine` alone would pool every patient's doses
   * together, which is exactly the bug this method exists to not have.
   */
  logsForPatientAndMedicine(
    patientId: Uuid,
    medicineId: Uuid,
    sinceIso?: string,
  ): Promise<IntakeLog[]> {
    return this.store.transaction(['intakeLogs'], (tx) =>
      tx.queryIndex<IntakeLog>('intakeLogs', {
        kind: 'range',
        fields: ['medicineId', 'patientId', 'actualTime'],
        prefix: [medicineId, patientId],
        lower: sinceIso ?? '',
        upper: RANGE_SENTINEL_MAX,
      }),
    );
  }

  /** The Today view's query, using the `[patientId+actualTime]` compound index. */
  logsForPatientBetween(patientId: Uuid, fromIso: string, toIso: string): Promise<IntakeLog[]> {
    return this.store.transaction(['intakeLogs'], (tx) =>
      tx.queryIndex<IntakeLog>('intakeLogs', {
        kind: 'range',
        fields: ['patientId', 'actualTime'],
        prefix: [patientId],
        lower: fromIso,
        upper: toIso,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Snooze (delta AD5)
  // -------------------------------------------------------------------------

  /**
   * Appends one deferral of one scheduled dose.
   *
   * Append-only like the intake ledger, and for the same reason: two caregivers snoozing the same
   * dose while offline must both survive the merge rather than one silently overwriting the
   * other. It also means the bound is a row count, with no counter to increment and get wrong.
   *
   * The caller supplies the whole record — `buildDoseSnooze` in `@medguard/shared` mints it, and
   * takes an explicit tap instant so a snooze captured on a lock screen dates from the tap rather
   * than from whenever the app got around to applying it.
   */
  async recordSnooze(snooze: DoseSnooze): Promise<DoseSnooze> {
    await this.store.transaction(['doseSnoozes', 'syncOutbox'], async (tx) => {
      await tx.put('doseSnoozes', snooze);
      await this.enqueue(tx, 'doseSnoozes', snooze.id, 'CREATE', snooze);
    });

    return snooze;
  }

  snoozesForOccurrence(occurrenceId: string): Promise<DoseSnooze[]> {
    return this.store.transaction(['doseSnoozes'], (tx) =>
      tx.queryIndex<DoseSnooze>('doseSnoozes', {
        kind: 'equals',
        fields: ['occurrenceId'],
        values: [occurrenceId],
      }),
    );
  }

  /**
   * Every snooze created since `sinceIso`, for the alarm engine's horizon pass and the Today
   * view — both need snoozes across many occurrences at once, and querying per occurrence would
   * be one round trip per row on screen.
   *
   * Bounded by time rather than unbounded because snoozes accumulate forever and only the recent
   * ones can still be deferring anything: a snooze older than the horizon cannot move an alarm
   * that is inside it.
   */
  recentSnoozes(sinceIso: string): Promise<DoseSnooze[]> {
    return this.store.transaction(['doseSnoozes'], (tx) =>
      tx.queryIndex<DoseSnooze>('doseSnoozes', {
        kind: 'range',
        fields: ['createdAt'],
        prefix: [],
        lower: sinceIso,
        upper: RANGE_SENTINEL_MAX,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Inventory
  // -------------------------------------------------------------------------

  async adjustInventory(input: ManualAdjustmentInput): Promise<InventoryAdjustment> {
    const adjustment = buildManualAdjustment(input, this.adjustmentContext());

    await this.store.transaction(['inventoryAdjustments', 'syncOutbox'], async (tx) => {
      await tx.put('inventoryAdjustments', adjustment);
      await this.enqueue(tx, 'inventoryAdjustments', adjustment.id, 'CREATE', adjustment);
    });

    return adjustment;
  }

  adjustmentsForMedicine(medicineId: Uuid): Promise<InventoryAdjustment[]> {
    return this.store.transaction(['inventoryAdjustments'], (tx) =>
      tx.queryIndex<InventoryAdjustment>('inventoryAdjustments', {
        kind: 'equals',
        fields: ['medicineId'],
        values: [medicineId],
      }),
    );
  }

  /**
   * Creates or updates the stock-tracking config (unit name, refill threshold) for a medicine.
   * Separate from `adjustInventory`: this describes how to track stock, not a change in the
   * quantity itself.
   */
  async saveInventoryItem(item: InventoryItem, action: SyncAction = 'UPDATE'): Promise<void> {
    const stamped = this.stamp(item);
    await this.store.transaction(['inventoryItems', 'syncOutbox'], async (tx) => {
      await tx.put('inventoryItems', stamped);
      await this.enqueue(tx, 'inventoryItems', stamped.id, action, stamped);
    });
  }

  async getInventoryItem(medicineId: Uuid): Promise<InventoryItem | undefined> {
    const matches = await this.store.transaction(['inventoryItems'], (tx) =>
      tx.queryIndex<InventoryItem>('inventoryItems', {
        kind: 'equals',
        fields: ['medicineId'],
        values: [medicineId],
      }),
    );
    return matches[0];
  }

  allInventoryItems(): Promise<InventoryItem[]> {
    return this.store.transaction(['inventoryItems'], (tx) =>
      tx.getAll<InventoryItem>('inventoryItems'),
    );
  }

  // -------------------------------------------------------------------------
  // Backup and restore
  // -------------------------------------------------------------------------

  /**
   * Writes every record in a validated backup bundle as-is — no business logic re-run. A dose in
   * the bundle does not generate a fresh inventory adjustment; its own paired adjustment, if any,
   * is already in the bundle. An import is a restore, not a re-enactment of every dose ever given.
   *
   * One transaction across every table: a backup half-applied by a crash or a full disk would
   * leave a household in a state matching neither the backup nor what was there before, which is
   * worse than either failing cleanly or succeeding cleanly.
   */
  async restoreBackup(
    bundle: Pick<
      BackupBundle,
      | 'patients'
      | 'medicinePatients'
      | 'medicines'
      | 'schedules'
      | 'intakeLogs'
      | 'inventoryItems'
      | 'inventoryAdjustments'
    >,
  ): Promise<void> {
    await this.store.transaction(
      [
        'patients',
        'medicinePatients',
        'medicines',
        'schedules',
        'intakeLogs',
        'inventoryItems',
        'inventoryAdjustments',
        'syncOutbox',
      ],
      async (tx) => {
        // Cast rather than remapped field-by-field: these arrays were already validated against
        // the exact same zod schemas the domain types are defined from — the only mismatch is
        // TypeScript's `exactOptionalPropertyTypes` being pickier about an explicit `undefined`
        // in an optional field's inferred type than the hand-written interfaces are.
        await tx.bulkPut('patients', bundle.patients as Patient[]);
        await tx.bulkPut('medicinePatients', bundle.medicinePatients as MedicinePatient[]);
        await tx.bulkPut('medicines', bundle.medicines as Medicine[]);
        await tx.bulkPut('schedules', bundle.schedules as Schedule[]);
        await tx.bulkPut('intakeLogs', bundle.intakeLogs as IntakeLog[]);
        await tx.bulkPut('inventoryItems', bundle.inventoryItems as InventoryItem[]);
        await tx.bulkPut(
          'inventoryAdjustments',
          bundle.inventoryAdjustments as InventoryAdjustment[],
        );

        for (const patient of bundle.patients) {
          await this.enqueue(tx, 'patients', patient.id, 'CREATE', patient);
        }
        for (const assignment of bundle.medicinePatients) {
          await this.enqueue(tx, 'medicinePatients', assignment.id, 'CREATE', assignment);
        }
        for (const medicine of bundle.medicines) {
          await this.enqueue(tx, 'medicines', medicine.id, 'CREATE', medicine);
        }
        for (const schedule of bundle.schedules) {
          await this.enqueue(tx, 'schedules', schedule.id, 'CREATE', schedule);
        }
        for (const log of bundle.intakeLogs) {
          await this.enqueue(tx, 'intakeLogs', log.id, 'CREATE', log);
        }
        for (const item of bundle.inventoryItems) {
          await this.enqueue(tx, 'inventoryItems', item.id, 'CREATE', item);
        }
        for (const adjustment of bundle.inventoryAdjustments) {
          await this.enqueue(tx, 'inventoryAdjustments', adjustment.id, 'CREATE', adjustment);
        }
      },
    );
  }

  /**
   * Wipes medicines, schedules, the full intake log, the inventory ledger and any outstanding
   * snoozes — everything a backup covers, plus the alarm bookkeeping that only means anything
   * against those schedules. Household settings and this device's own identity/session are left
   * alone: this clears medical data, not the household connection.
   *
   * Local only, and structurally cannot be otherwise: nothing in the sync protocol supports
   * deleting a record (see docs/data-handling.md), so this action has no way to reach — and no
   * way to affect — another caregiver's device.
   */
  async clearAllData(): Promise<void> {
    await this.store.transaction(
      [
        'patients',
        'medicinePatients',
        'medicines',
        'schedules',
        'intakeLogs',
        'inventoryItems',
        'inventoryAdjustments',
        'doseSnoozes',
        'syncOutbox',
        'syncMeta',
      ],
      async (tx) => {
        await tx.clear('patients');
        await tx.clear('medicinePatients');
        await tx.clear('medicines');
        await tx.clear('schedules');
        await tx.clear('intakeLogs');
        await tx.clear('inventoryItems');
        await tx.clear('inventoryAdjustments');
        await tx.clear('doseSnoozes');

        const staleOutbox = await tx.queryIndex<SyncOutboxEntry>('syncOutbox', {
          kind: 'anyOf',
          fields: ['table'],
          values: [
            'patients',
            'medicinePatients',
            'medicines',
            'schedules',
            'intakeLogs',
            'inventoryItems',
            'inventoryAdjustments',
            'doseSnoozes',
          ],
        });
        for (const entry of staleOutbox) {
          await tx.delete('syncOutbox', entry.id!);
        }

        // The pull cursor belongs to whichever household this device was just connected to —
        // meaningless once that connection is gone, and actively wrong if a different household
        // is joined next (each has its own independent sequence).
        await tx.clear('syncMeta');
      },
    );
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
