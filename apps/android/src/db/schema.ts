import Dexie from 'dexie';
import type { Table } from 'dexie';
import type {
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
 * The Android client's local-first database, running on the Capacitor WebView's IndexedDB.
 *
 * Table names are deliberately identical to `apps/web/src/db/schema.ts` and to the
 * `SyncableTable` union in `packages/shared/src/types.ts`: the outbox stores its table name
 * verbatim and the server dispatches on it, so a table called `inventory` here rather than
 * `inventoryItems` would queue changes the API cannot route.
 *
 * Two index choices carry over from the web schema for the same reason they were made there —
 * both queries run on every render and must not degrade as a child's dosing history grows:
 *
 *   `[medicineId+actualTime]` — the rolling 24-hour cap check on the PRN screen.
 *   `[patientId+actualTime]`  — the Today view.
 *
 * `active` and `archived` are **not** indexed. IndexedDB cannot index a boolean value, so
 * `where('active').equals(1)` matches nothing at all — silently, with no error. Both flags are
 * filtered in memory instead.
 */
export class AndroidMedGuardDB extends Dexie {
  householdSettings!: Table<HouseholdSettings, string>;
  medicines!: Table<Medicine, string>;
  schedules!: Table<Schedule, string>;
  intakeLogs!: Table<IntakeLog, string>;
  inventoryItems!: Table<InventoryItem, string>;
  inventoryAdjustments!: Table<InventoryAdjustment, string>;
  shabbatConfig!: Table<ShabbatConfig, string>;
  syncOutbox!: Table<SyncOutboxEntry, number>;

  constructor(name = 'AndroidMedGuardDB') {
    super(name);

    this.version(1).stores({
      householdSettings: 'id',
      medicines: 'id, patientId, name, syncStatus, updatedAt',
      schedules: 'id, medicineId, patientId, regimenGroupId, syncStatus, updatedAt',
      intakeLogs:
        'id, patientId, medicineId, scheduleId, status, type, actualTime, syncStatus, supersedesId, [medicineId+actualTime], [patientId+actualTime]',
      inventoryItems: 'id, medicineId, syncStatus, updatedAt',
      inventoryAdjustments: 'id, medicineId, relatedLogId, createdAt, syncStatus',
      shabbatConfig: 'id, patientId',
      syncOutbox: '++id, table, entityId, action, createdAt',
    });
  }
}
