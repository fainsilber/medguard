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
