import { hasPendingChanges, isAppendOnlyTable, mergeLww } from '@medguard/shared';
import type { LwwRecord, SyncableTable } from '@medguard/shared';
import type { Store, StoreTransaction } from './types.js';

/**
 * Applying a pulled record, and marking a pushed one synced, both dispatch on whether the table
 * is append-only or LWW — driven by `isAppendOnlyTable` from `@medguard/shared`, the single
 * classification `apps/api/src/sync/tables.ts` and the client also read, rather than a second,
 * hand-maintained switch that could drift from it.
 */

export interface PulledRecord {
  table: SyncableTable;
  id: string;
  payload: unknown;
}

async function applyLww<T extends LwwRecord>(
  tx: StoreTransaction,
  table: SyncableTable,
  record: PulledRecord,
): Promise<void> {
  const incoming = { ...(record.payload as T), syncStatus: 'synced' as const };
  const local = await tx.get<T>(table, record.id);

  if (!local) {
    await tx.put(table, incoming);
    return;
  }
  if (hasPendingChanges(local)) {
    // An unacknowledged local edit must never be clobbered by an incoming pull. The outbox drain
    // will push it, and a later pull brings back whatever the server authoritatively resolved to.
    return;
  }
  const winner = mergeLww(local, incoming).winner;
  await tx.put(table, { ...winner, syncStatus: 'synced' });
}

async function applyAppendOnly<T extends { id: string }>(
  tx: StoreTransaction,
  table: SyncableTable,
  record: PulledRecord,
): Promise<void> {
  const local = await tx.get<T>(table, record.id);
  if (local) {
    // Immutable content by id — nothing to merge. If this is the device's own record round-
    // tripping back, its syncStatus is reconciled by the outbox drain that pushed it, not here.
    return;
  }
  await tx.put(table, { ...(record.payload as T), syncStatus: 'synced' as const });
}

/** Merges one pulled record into the correct local table, per the write rule for that table. */
export async function applyPulledRecord(store: Store, record: PulledRecord): Promise<void> {
  await store.transaction([record.table], (tx) =>
    isAppendOnlyTable(record.table)
      ? applyAppendOnly(tx, record.table, record)
      : applyLww(tx, record.table, record),
  );
}

/**
 * Flips a record's local `syncStatus` to 'synced' right after the server has acknowledged it,
 * rather than waiting for that record to round-trip back through a future pull. Without this,
 * `hasPendingChanges` would never actually become false for anything, and a pull could wrongly
 * treat every local record as having an unacknowledged edit forever.
 */
export async function markSyncedLocally(store: Store, table: SyncableTable, id: string): Promise<void> {
  await store.transaction([table], (tx) => tx.update(table, id, { syncStatus: 'synced' }));
}
