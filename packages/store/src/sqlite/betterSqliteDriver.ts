import type Database from 'better-sqlite3';
import type { SqlDriver, SqlRunResult } from './sqlDriver.js';
import { SQLITE_TABLE_SCHEMAS, buildCreateStatements } from './schema.js';

/**
 * `better-sqlite3` is synchronous end-to-end; `SqlDriver` is async so it can share an interface
 * with `expo-sqlite`'s async API on Android — every method here just wraps a sync call in an
 * already-resolved Promise. Used for the SQLite half of the conformance suite, and reusable
 * anywhere else Node needs the same `Store` (there is no Android-only dependency in this file).
 */
export class BetterSqliteDriver implements SqlDriver {
  constructor(private readonly db: Database.Database) {}

  async run(sql: string, params: readonly unknown[]): Promise<SqlRunResult> {
    const result = this.db.prepare(sql).run(...(params as unknown[]));
    return { changes: result.changes };
  }

  async runReturningId(sql: string, params: readonly unknown[]): Promise<number> {
    const result = this.db.prepare(sql).run(...(params as unknown[]));
    return Number(result.lastInsertRowid);
  }

  async all<T = unknown>(sql: string, params: readonly unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as unknown[])) as T[];
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // better-sqlite3's own `.transaction()` helper only wraps synchronous functions; every
    // `SqliteStore` operation is async (see the module doc above), so this drives
    // BEGIN/COMMIT/ROLLBACK by hand instead.
    this.db.exec('BEGIN');
    try {
      const result = await fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Creates every table and index this store needs. Idempotent — safe to call on every startup. */
export function createSqliteSchema(db: Database.Database): void {
  for (const schema of SQLITE_TABLE_SCHEMAS) {
    for (const statement of buildCreateStatements(schema)) {
      db.exec(statement);
    }
  }
}
