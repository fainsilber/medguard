import { fromIso } from './clock.js';
import type { Syncable } from './types.js';

/**
 * Last-Write-Wins conflict resolution, for genuinely mutable records only.
 *
 * Note what *cannot* be passed here, by construction rather than by convention: `IntakeLog` and
 * `InventoryAdjustment` do not extend `Syncable` — they carry no `updatedAt`, because they are
 * append-only and are never overwritten. A dose history resolved by LWW would silently drop a
 * caregiver's log (safety invariant 1), and a stock counter resolved by LWW would drop a
 * decrement (the reason the inventory ledger is append-only too, not a mutable counter). The
 * type signature makes both mistakes unrepresentable.
 *
 * So this applies to medicines, schedules, inventory *settings*, Shabbat config and household
 * settings — records where "the most recent edit is the truth" is genuinely correct.
 */

export type LwwRecord = Syncable & { id: string };

export type MergeSource = 'local' | 'remote' | 'identical';

export interface MergeOutcome<T> {
  winner: T;
  source: MergeSource;
}

/**
 * Resolves two versions of the same record.
 *
 * Ties on `updatedAt` are broken by device id rather than by arrival order: two phones can
 * genuinely write in the same millisecond, and "whichever reached the server first" would give
 * different answers on different devices — leaving the household permanently disagreeing about
 * a dose schedule. Comparing device ids is arbitrary but identical everywhere.
 */
export function mergeLww<T extends LwwRecord>(local: T, remote: T): MergeOutcome<T> {
  if (local.id !== remote.id) {
    throw new Error(`Cannot merge different records: ${local.id} vs ${remote.id}`);
  }

  const localMs = fromIso(local.updatedAt);
  const remoteMs = fromIso(remote.updatedAt);

  if (localMs > remoteMs) {
    return { winner: local, source: 'local' };
  }
  if (remoteMs > localMs) {
    return { winner: remote, source: 'remote' };
  }

  if (local.updatedByDeviceId === remote.updatedByDeviceId) {
    return { winner: remote, source: 'identical' };
  }

  return local.updatedByDeviceId > remote.updatedByDeviceId
    ? { winner: local, source: 'local' }
    : { winner: remote, source: 'remote' };
}

/**
 * Merges an incoming set of records into a local set, by id.
 *
 * Records present on only one side are kept as-is; records on both are resolved by `mergeLww`.
 * Order of the result follows local order first, then any records seen only remotely, so the
 * output is stable regardless of how the server happened to page its response.
 */
export function mergeCollections<T extends LwwRecord>(
  local: readonly T[],
  remote: readonly T[],
): T[] {
  const remoteById = new Map(remote.map((record) => [record.id, record]));
  const merged: T[] = [];
  const consumed = new Set<string>();

  for (const localRecord of local) {
    const remoteRecord = remoteById.get(localRecord.id);
    if (remoteRecord === undefined) {
      merged.push(localRecord);
      continue;
    }
    consumed.add(localRecord.id);
    merged.push(mergeLww(localRecord, remoteRecord).winner);
  }

  for (const remoteRecord of remote) {
    if (!consumed.has(remoteRecord.id)) {
      merged.push(remoteRecord);
    }
  }

  return merged;
}

/**
 * Whether a local record still has unsynced changes the server has not acknowledged.
 *
 * Used to decide whether a remote version may overwrite it wholesale, and to drive the
 * "pending N" sync indicator the UI must keep visible (safety invariant 6).
 */
export function hasPendingChanges(record: Pick<Syncable, 'syncStatus'>): boolean {
  return record.syncStatus === 'pending';
}
