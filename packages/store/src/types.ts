/**
 * The storage-agnostic port `apps/web` (Dexie) and `apps/android` (SQLite) both implement.
 *
 * Deliberately narrow — `transaction`, `get`, `put`, `bulkPut`, `append`, `update`, `delete`,
 * `clear` and `queryIndex` are exactly the operations `MedGuardRepository`, the sync engine,
 * `cursor.ts` and `tableDispatch.ts` actually call (docs/android-client-plan.md, "Storage and the
 * sync port"). It is not a general-purpose database abstraction, and should not grow one: every
 * method here exists because a real caller in this package needs it.
 *
 * Every write happens inside `transaction()` — the same atomicity guarantee
 * `apps/web/src/db/repository.ts` had via `Dexie.transaction('rw', ...)`, now expressed against
 * whichever engine is underneath.
 */

/** A record identity. Every table's rows carry a string `id`, except `syncOutbox`, which is keyed
 * by an auto-incrementing number `append()` assigns. */
export type RecordId = string | number;

/**
 * Describes an indexed read. `fields` names one or more columns, in the same order Dexie's
 * compound-index tuples encode them (e.g. `['medicineId', 'actualTime']` for `[medicineId+actualTime]`).
 *
 * - `equals`: an exact-match prefix over `fields` (usually just the first field).
 * - `anyOf`: an exact match against any of several values of the first field — the one case
 *   (`clearAllData`'s outbox purge) that needs an IN-style filter rather than a single equality.
 * - `range`: a bounded scan over the last field in `fields`, after an exact-match prefix over the
 *   fields before it. `lower`/`upper` are inclusive, matching Dexie's `.between()` default.
 * - `all`: every row, ordered by `fields[0]` — used for `syncOutbox`'s oldest-first drain order
 *   and nothing else; a bare table scan uses `getAll()` instead.
 */
export type IndexQuery =
  | { kind: 'equals'; fields: [string, ...string[]]; values: unknown[] }
  | { kind: 'anyOf'; fields: [string]; values: unknown[] }
  | {
      kind: 'range';
      fields: [string, ...string[]];
      prefix: unknown[];
      lower: unknown;
      upper: unknown;
    }
  | { kind: 'all'; orderBy: string };

export interface StoreTransaction {
  get<T>(table: string, id: RecordId): Promise<T | undefined>;
  /** Every row in a table, in unspecified order — for the small, rarely-huge tables (medicines,
   * schedules, inventory items) that are always read in full and filtered/sorted by the caller. */
  getAll<T>(table: string): Promise<T[]>;
  put<T>(table: string, record: T): Promise<void>;
  bulkPut<T>(table: string, records: T[]): Promise<void>;
  /** Assigns and returns a fresh auto-incrementing id — `syncOutbox` only. */
  append<T>(table: string, record: T): Promise<number>;
  /** A shallow merge onto the stored record, matching Dexie's `Table.update` semantics. */
  update<T>(table: string, id: RecordId, changes: Partial<T>): Promise<void>;
  delete(table: string, id: RecordId): Promise<void>;
  clear(table: string): Promise<void>;
  count(table: string): Promise<number>;
  queryIndex<T>(table: string, query: IndexQuery): Promise<T[]>;
}

export interface Store {
  /**
   * Runs `fn` against a transaction that spans every table named in `tables`. Every write inside
   * `fn` commits or none do — the guarantee `recordDose()` needs across the log, the ledger entry
   * and both outbox rows (safety invariant: no dose recorded without its stock movement, no stock
   * movement without its dose).
   */
  transaction<T>(tables: readonly string[], fn: (tx: StoreTransaction) => Promise<T>): Promise<T>;
}
