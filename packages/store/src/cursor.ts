import type { IsoInstant } from '@medguard/shared';
import type { Store } from './types.js';

/**
 * Where the sync engine resumes pulling from, persisted locally so a restart doesn't force a
 * full re-bootstrap.
 *
 * Tagged with the household id it belongs to: each household has its own independent sequence
 * counter, so a cursor number from one household means nothing in another. Switching households
 * (leave, then join or create a different one) makes any stored cursor stale — treating a mismatch
 * as "no cursor yet" rather than trusting the number at face value is what makes this self-healing
 * even if `clearAllData()` were ever skipped on the way out.
 */

const SYNC_META_TABLE = 'syncMeta';
const CURSOR_KEY = 'cursor';
const LAST_SYNCED_AT_KEY = 'lastSyncedAt';

interface StoredCursor {
  householdId: string;
  cursor: number;
}

export async function getCursor(store: Store, householdId: string): Promise<number | undefined> {
  const row = await store.transaction([SYNC_META_TABLE], (tx) =>
    tx.get<{ key: string; value: unknown }>(SYNC_META_TABLE, CURSOR_KEY),
  );
  if (!row) {
    return undefined;
  }
  const stored = row.value as StoredCursor;
  return stored.householdId === householdId ? stored.cursor : undefined;
}

export async function setCursor(store: Store, householdId: string, cursor: number): Promise<void> {
  const stored: StoredCursor = { householdId, cursor };
  await store.transaction([SYNC_META_TABLE], (tx) =>
    tx.put(SYNC_META_TABLE, { key: CURSOR_KEY, value: stored }),
  );
}

/**
 * When this device last completed a pull.
 *
 * Distinct from the cursor, and needed for a different reason: the cursor says *where* we resumed
 * from, never *when*. "The socket is closed right now" (which the sync status already knows) and
 * "this device has not heard from the household in a day" are different problems — the first is
 * routine, the second means the alarms this device is arming may be built from a schedule someone
 * changed yesterday. Safety invariant 6 requires the second be visible, and nothing recorded it.
 *
 * Deliberately not household-tagged, unlike the cursor: `clearAllData()` wipes `syncMeta` on the
 * way out of a household, so a stale value cannot survive into a different one.
 */
export async function getLastSyncedAt(store: Store): Promise<IsoInstant | undefined> {
  const row = await store.transaction([SYNC_META_TABLE], (tx) =>
    tx.get<{ key: string; value: unknown }>(SYNC_META_TABLE, LAST_SYNCED_AT_KEY),
  );
  return row === undefined ? undefined : (row.value as IsoInstant);
}

export async function setLastSyncedAt(store: Store, iso: IsoInstant): Promise<void> {
  await store.transaction([SYNC_META_TABLE], (tx) =>
    tx.put(SYNC_META_TABLE, { key: LAST_SYNCED_AT_KEY, value: iso }),
  );
}

const RECONCILIATION_DISMISSED_KEY = 'reconciliationDismissedWindowId';

/**
 * The Shabbat window whose reconciliation sheet this device has been shown and told "later"
 * (Sprint A5 phase 2).
 *
 * Local-only and never synced, deliberately: which device has already interrupted its owner is
 * not a fact about the household, and syncing it would mean one caregiver dismissing the sheet
 * silently suppresses it on the other's phone — where the doses are just as unreconciled.
 *
 * Keyed by window id rather than a boolean, so the next Shabbat opens the sheet again without
 * anything having to remember to clear a flag.
 */
export async function getDismissedReconciliation(store: Store): Promise<string | undefined> {
  const row = await store.transaction([SYNC_META_TABLE], (tx) =>
    tx.get<{ key: string; value: unknown }>(SYNC_META_TABLE, RECONCILIATION_DISMISSED_KEY),
  );
  return row === undefined ? undefined : (row.value as string);
}

export async function setDismissedReconciliation(store: Store, windowId: string): Promise<void> {
  await store.transaction([SYNC_META_TABLE], (tx) =>
    tx.put(SYNC_META_TABLE, { key: RECONCILIATION_DISMISSED_KEY, value: windowId }),
  );
}
