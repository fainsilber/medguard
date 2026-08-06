/**
 * The minimal SQL surface `SqliteStore` needs. Two implementations exist: `better-sqlite3` for
 * Node (tests, and the conformance suite's SQLite half) and `apps/android/src/store`'s
 * `expo-sqlite`-backed driver for the real device. Both are equally thin wrappers — the actual
 * SQL generation lives once, in `sqliteStore.ts`, so the two platforms cannot drift on what a
 * query means, only on how a statement gets to the database file.
 */

export interface SqlRunResult {
  changes: number;
}

export interface SqlDriver {
  run(sql: string, params: readonly unknown[]): Promise<SqlRunResult>;
  /** Same as `run`, but for an `INSERT` into an auto-incrementing primary key — returns the
   * assigned row id. */
  runReturningId(sql: string, params: readonly unknown[]): Promise<number>;
  all<T = unknown>(sql: string, params: readonly unknown[]): Promise<T[]>;
  /** Runs `fn` inside `BEGIN`/`COMMIT`, rolling back on any rejection. */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
}
