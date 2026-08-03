import { fromIso } from '@medguard/shared';
import type { SyncableTable } from '@medguard/shared';
import { SYNCED_TABLES, TABLES, syncStampFor } from './tables.js';
import type { TableConfig } from './tables.js';

/**
 * Reading and writing synced records, household-scoped, with the write rules from tables.ts
 * applied in exactly one place.
 *
 * Every method here takes `householdId` as its first argument and puts it in the WHERE clause.
 * That is not defensive style — it is the authorization boundary. A query that forgets it returns
 * another family's child's medication history.
 */

export interface SyncRecordRow {
  table: SyncableTable;
  id: string;
  seq: number;
  payload: unknown;
}

export type PushOutcome = 'applied' | 'duplicate' | 'superseded';

export interface PushResult {
  table: SyncableTable;
  id: string;
  outcome: PushOutcome;
}

/** How many records a single pull returns. Bounded so a device offline for weeks pages instead of timing out. */
export const PULL_PAGE_SIZE = 500;

function parseRow(table: SyncableTable, row: { id: string; seq: number; payload: string }): SyncRecordRow {
  return { table, id: row.id, seq: row.seq, payload: JSON.parse(row.payload) };
}

/**
 * Claims the next sequence number for a household.
 *
 * `change_seq = change_seq + 1` is evaluated by SQLite itself, so two concurrent writers cannot
 * both read the same value and hand out the same cursor position — which would make one of the
 * two records invisible to every device that had already pulled past it.
 */
async function nextSeq(db: D1Database, householdId: string): Promise<number> {
  const row = await db
    .prepare('UPDATE households SET change_seq = change_seq + 1 WHERE id = ? RETURNING change_seq')
    .bind(householdId)
    .first<{ change_seq: number }>();

  if (!row) {
    throw new Error(`No such household: ${householdId}`);
  }
  return row.change_seq;
}

export async function currentCursor(db: D1Database, householdId: string): Promise<number> {
  const row = await db
    .prepare('SELECT change_seq FROM households WHERE id = ?')
    .bind(householdId)
    .first<{ change_seq: number }>();
  return row?.change_seq ?? 0;
}

/** Everything in the household, for a device joining or recovering from scratch. */
export async function readAll(db: D1Database, householdId: string): Promise<SyncRecordRow[]> {
  const records: SyncRecordRow[] = [];

  for (const table of SYNCED_TABLES) {
    const { results } = await db
      .prepare(
        `SELECT id, seq, payload FROM ${TABLES[table].sqlTable} WHERE household_id = ? ORDER BY seq`,
      )
      .bind(householdId)
      .all<{ id: string; seq: number; payload: string }>();

    records.push(...results.map((row) => parseRow(table, row)));
  }

  return records.sort((a, b) => a.seq - b.seq);
}

/**
 * Everything written after `cursor`, oldest first.
 *
 * Strictly greater than, never greater-or-equal: a client resuming from the cursor it was last
 * given must not be handed that same record again, but must also never skip past one.
 */
export async function readSince(
  db: D1Database,
  householdId: string,
  cursor: number,
  limit = PULL_PAGE_SIZE,
): Promise<SyncRecordRow[]> {
  const records: SyncRecordRow[] = [];

  for (const table of SYNCED_TABLES) {
    const { results } = await db
      .prepare(
        `SELECT id, seq, payload FROM ${TABLES[table].sqlTable}
         WHERE household_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .bind(householdId, cursor, limit)
      .all<{ id: string; seq: number; payload: string }>();

    records.push(...results.map((row) => parseRow(table, row)));
  }

  // Sorted then truncated across tables, so the caller's next cursor is always a position every
  // table has been read up to — never one that skips a record in a table that sorted later.
  return records.sort((a, b) => a.seq - b.seq).slice(0, limit);
}

async function existing(
  db: D1Database,
  config: TableConfig,
  householdId: string,
  id: string,
): Promise<{ updated_at: string; updated_by_device_id: string } | null> {
  return db
    .prepare(
      `SELECT updated_at, updated_by_device_id FROM ${config.sqlTable} WHERE household_id = ? AND id = ?`,
    )
    .bind(householdId, id)
    .first<{ updated_at: string; updated_by_device_id: string }>();
}

/**
 * Decides whether an incoming version should replace the stored one, using the same
 * Last-Write-Wins rule as the client (`mergeLww` in packages/shared).
 *
 * The tie-break on device id is what makes this deterministic: two phones can genuinely write in
 * the same millisecond, and resolving by arrival order would leave devices permanently disagreeing
 * about a dose schedule depending on which reached the server first.
 */
function incomingWins(
  incoming: { updatedAt: string; updatedByDeviceId: string },
  stored: { updated_at: string; updated_by_device_id: string },
): boolean {
  const incomingMs = fromIso(incoming.updatedAt);
  const storedMs = fromIso(stored.updated_at);

  if (incomingMs !== storedMs) {
    return incomingMs > storedMs;
  }
  return incoming.updatedByDeviceId > stored.updated_by_device_id;
}

/**
 * Applies one validated record.
 *
 * Returns `duplicate` when an append-only row has already been stored — that is the idempotency
 * guarantee that makes retrying a dropped batch safe, and it is the difference between a resent
 * request and a second dose. Returns `superseded` when a Last-Write-Wins record lost to a newer
 * version already on the server.
 */
export async function applyRecord(
  db: D1Database,
  householdId: string,
  table: SyncableTable,
  record: Record<string, unknown>,
): Promise<PushOutcome> {
  const config = TABLES[table];
  const id = String(record.id);
  const stored = await existing(db, config, householdId, id);

  if (stored && config.writeRule === 'append_only') {
    return 'duplicate';
  }

  const stamp = syncStampFor(config, record);

  if (stored && !incomingWins(stamp, stored)) {
    return 'superseded';
  }

  const columns = config.columns(record as Record<string, never>);
  const seq = await nextSeq(db, householdId);

  const names = ['id', 'household_id', 'seq', 'updated_at', 'updated_by_device_id', 'payload', ...Object.keys(columns)];
  const values = [
    id,
    householdId,
    seq,
    stamp.updatedAt,
    stamp.updatedByDeviceId,
    JSON.stringify(record),
    ...Object.values(columns),
  ];

  // ON CONFLICT rather than delete-then-insert: the row must never be briefly absent, or a
  // concurrent read could see a household with a medicine's schedule temporarily missing.
  const assignments = names
    .filter((name) => name !== 'id' && name !== 'household_id')
    .map((name) => `${name} = excluded.${name}`)
    .join(', ');

  await db
    .prepare(
      `INSERT INTO ${config.sqlTable} (${names.join(', ')})
       VALUES (${names.map(() => '?').join(', ')})
       ON CONFLICT (household_id, id) DO UPDATE SET ${assignments}`,
    )
    .bind(...values)
    .run();

  return 'applied';
}
