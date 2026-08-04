import type { MedGuardDB } from '../db/schema.js';

/**
 * Where the sync engine resumes pulling from, persisted locally so a page reload doesn't force a
 * full re-bootstrap.
 *
 * Tagged with the household id it belongs to: each household has its own independent sequence
 * counter, so a cursor number from one household means nothing in another. Switching households
 * (leave, then join or create a different one) makes any stored cursor stale — treating a mismatch
 * as "no cursor yet" rather than trusting the number at face value is what makes this self-healing
 * even if `clearAllData()` were ever skipped on the way out.
 */

const CURSOR_KEY = 'cursor';

interface StoredCursor {
  householdId: string;
  cursor: number;
}

export async function getCursor(db: MedGuardDB, householdId: string): Promise<number | undefined> {
  const row = await db.syncMeta.get(CURSOR_KEY);
  if (!row) {
    return undefined;
  }
  const stored = row.value as StoredCursor;
  return stored.householdId === householdId ? stored.cursor : undefined;
}

export async function setCursor(db: MedGuardDB, householdId: string, cursor: number): Promise<void> {
  const stored: StoredCursor = { householdId, cursor };
  await db.syncMeta.put({ key: CURSOR_KEY, value: stored });
}
