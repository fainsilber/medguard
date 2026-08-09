import Dexie from 'dexie';
import type { Table } from 'dexie';
import type {
  DoseSnooze,
  HouseholdSettings,
  IntakeLog,
  InventoryAdjustment,
  InventoryItem,
  Medicine,
  Schedule,
  ShabbatConfig,
  SyncOutboxEntry,
} from '@medguard/shared';

/**
 * The local-first database. Every read the UI performs comes from here, and every write lands
 * here first and syncs afterwards (safety invariant 4 — local writes never block on the network).
 *
 * Index choices are driven by the two queries that run constantly and must not degrade as a
 * child's dosing history grows over months of treatment:
 *
 *   `[medicineId+actualTime]` — the rolling 24-hour cap check, run every time a PRN screen renders.
 *   `[patientId+actualTime]`  — the Today view.
 *
 * Without those compound indexes both become full scans of the entire intake history.
 */
export class MedGuardDB extends Dexie {
  householdSettings!: Table<HouseholdSettings, string>;
  medicines!: Table<Medicine, string>;
  schedules!: Table<Schedule, string>;
  intakeLogs!: Table<IntakeLog, string>;
  inventoryItems!: Table<InventoryItem, string>;
  inventoryAdjustments!: Table<InventoryAdjustment, string>;
  doseSnoozes!: Table<DoseSnooze, string>;
  shabbatConfig!: Table<ShabbatConfig, string>;
  syncOutbox!: Table<SyncOutboxEntry, number>;
  /** Local-only bookkeeping (the pull cursor) — never synced itself, never read by domain code. */
  syncMeta!: Table<{ key: string; value: unknown }, string>;

  constructor(name = 'MedGuardDB') {
    super(name);

    this.version(1).stores({
      householdSettings: 'id',
      // `archived` is indexed because every list view filters on it — medicines are never
      // deleted, so the archived set only grows.
      medicines: 'id, patientId, name, archived, syncStatus, updatedAt',
      schedules: 'id, medicineId, patientId, active, regimenGroupId, syncStatus, updatedAt',
      // `supersedesId` is indexed so a correction chain can be walked without scanning.
      intakeLogs:
        'id, patientId, medicineId, scheduleId, status, type, actualTime, syncStatus, supersedesId, [medicineId+actualTime], [patientId+actualTime]',
      inventoryItems: 'id, medicineId, syncStatus, updatedAt',
      inventoryAdjustments: 'id, medicineId, relatedLogId, createdAt, syncStatus',
      shabbatConfig: 'id, patientId',
      syncOutbox: '++id, table, entityId, action, createdAt',
    });

    // Sprint 4: the live sync engine needs somewhere to remember how far it's pulled.
    this.version(2).stores({
      householdSettings: 'id',
      medicines: 'id, patientId, name, archived, syncStatus, updatedAt',
      schedules: 'id, medicineId, patientId, active, regimenGroupId, syncStatus, updatedAt',
      intakeLogs:
        'id, patientId, medicineId, scheduleId, status, type, actualTime, syncStatus, supersedesId, [medicineId+actualTime], [patientId+actualTime]',
      inventoryItems: 'id, medicineId, syncStatus, updatedAt',
      inventoryAdjustments: 'id, medicineId, relatedLogId, createdAt, syncStatus',
      shabbatConfig: 'id, patientId',
      syncOutbox: '++id, table, entityId, action, createdAt',
      syncMeta: 'key',
    });

    // Sprint A3 (delta AD5): snooze becomes an append-only synced record rather than a component
    // `Map` that a reload clears. Purely additive — a new table needs no `upgrade()` callback, and
    // Dexie carries every earlier table forward untouched.
    //
    // The web app never *writes* a snooze: the bounded-snooze UI is Android-only for now. It needs
    // the table anyway, because a snooze made on a phone arrives in this device's pull and
    // `applyPulledRecord` would otherwise fail to land it.
    this.version(3).stores({
      householdSettings: 'id',
      medicines: 'id, patientId, name, archived, syncStatus, updatedAt',
      schedules: 'id, medicineId, patientId, active, regimenGroupId, syncStatus, updatedAt',
      intakeLogs:
        'id, patientId, medicineId, scheduleId, status, type, actualTime, syncStatus, supersedesId, [medicineId+actualTime], [patientId+actualTime]',
      inventoryItems: 'id, medicineId, syncStatus, updatedAt',
      inventoryAdjustments: 'id, medicineId, relatedLogId, createdAt, syncStatus',
      doseSnoozes: 'id, occurrenceId, createdAt, syncStatus',
      shabbatConfig: 'id, patientId',
      syncOutbox: '++id, table, entityId, action, createdAt',
      syncMeta: 'key',
    });
  }
}
