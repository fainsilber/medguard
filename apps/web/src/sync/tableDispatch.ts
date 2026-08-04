import { hasPendingChanges, mergeLww } from '@medguard/shared';
import type { LwwRecord, SyncableTable } from '@medguard/shared';
import type { Table } from 'dexie';
import type { MedGuardDB } from '../db/schema.js';

/**
 * Applying a pulled record and marking a pushed one synced both need to reach "whichever Dexie
 * table this `SyncableTable` name refers to" — written out per-table rather than through a
 * generic lookup, because a lookup returning a union of seven different `Table<T, string>` types
 * cannot be called with a record typed for just one of them without casting the escape hatch back
 * open. Seven explicit cases keeps each branch fully type-checked.
 */

export interface PulledRecord {
  table: SyncableTable;
  id: string;
  payload: unknown;
}

async function applyLww<T extends LwwRecord>(table: Table<T, string>, record: PulledRecord): Promise<void> {
  const incoming = { ...(record.payload as T), syncStatus: 'synced' as const };
  const local = await table.get(record.id);

  if (!local) {
    await table.put(incoming);
    return;
  }
  if (hasPendingChanges(local)) {
    // An unacknowledged local edit must never be clobbered by an incoming pull. The outbox drain
    // will push it, and a later pull brings back whatever the server authoritatively resolved to.
    return;
  }
  const winner = mergeLww(local, incoming).winner;
  await table.put({ ...winner, syncStatus: 'synced' });
}

async function applyAppendOnly<T extends { id: string }>(
  table: Table<T, string>,
  record: PulledRecord,
): Promise<void> {
  const local = await table.get(record.id);
  if (local) {
    // Immutable content by id — nothing to merge. If this is the device's own record round-
    // tripping back, its syncStatus is reconciled by the outbox drain that pushed it, not here.
    return;
  }
  await table.put({ ...(record.payload as T), syncStatus: 'synced' as const });
}

/** Merges one pulled record into the correct local table, per the write rule for that table. */
export async function applyPulledRecord(db: MedGuardDB, record: PulledRecord): Promise<void> {
  switch (record.table) {
    case 'householdSettings':
      return applyLww(db.householdSettings, record);
    case 'medicines':
      return applyLww(db.medicines, record);
    case 'schedules':
      return applyLww(db.schedules, record);
    case 'inventoryItems':
      return applyLww(db.inventoryItems, record);
    case 'shabbatConfig':
      return applyLww(db.shabbatConfig, record);
    case 'intakeLogs':
      return applyAppendOnly(db.intakeLogs, record);
    case 'inventoryAdjustments':
      return applyAppendOnly(db.inventoryAdjustments, record);
  }
}

/**
 * Flips a record's local `syncStatus` to 'synced' right after the server has acknowledged it,
 * rather than waiting for that record to round-trip back through a future pull. Without this,
 * `hasPendingChanges` would never actually become false for anything, and a pull could wrongly
 * treat every local record as having an unacknowledged edit forever.
 */
export async function markSyncedLocally(db: MedGuardDB, table: SyncableTable, id: string): Promise<void> {
  switch (table) {
    case 'householdSettings':
      await db.householdSettings.update(id, { syncStatus: 'synced' });
      return;
    case 'medicines':
      await db.medicines.update(id, { syncStatus: 'synced' });
      return;
    case 'schedules':
      await db.schedules.update(id, { syncStatus: 'synced' });
      return;
    case 'inventoryItems':
      await db.inventoryItems.update(id, { syncStatus: 'synced' });
      return;
    case 'shabbatConfig':
      await db.shabbatConfig.update(id, { syncStatus: 'synced' });
      return;
    case 'intakeLogs':
      await db.intakeLogs.update(id, { syncStatus: 'synced' });
      return;
    case 'inventoryAdjustments':
      await db.inventoryAdjustments.update(id, { syncStatus: 'synced' });
      return;
  }
}
