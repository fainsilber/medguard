import type { SQLiteDatabase } from 'expo-sqlite';
import { SQLITE_TABLE_SCHEMAS, buildCreateStatements } from '@medguard/store/sqlite';
import type { SqlDriver, SqlRunResult } from '@medguard/store/sqlite';

/**
 * The Android half of the `SqlDriver` pair (`packages/store/src/sqlite/betterSqliteDriver.ts` is
 * the other, Node-only half used by tests). All the SQL generation — every `CREATE TABLE`, every
 * query — lives once in `packages/store`; this file is only the thin adapter onto `expo-sqlite`'s
 * async API, so the two platforms cannot drift on what a query means (docs/android-client-plan.md,
 * "Storage and the sync port").
 *
 * Unverified on-device (Sprint A1, see apps/android/README.md "What hasn't been verified"): this
 * sandbox has no Android SDK/emulator/device, so this file has been reviewed against
 * `expo-sqlite`'s installed type declarations but never actually run against real SQLite through
 * the Expo runtime. `SQLiteRunResult`'s `lastInsertRowId`/`changes` fields and
 * `withTransactionAsync`'s rollback-on-throw behavior are taken from the package's own `.d.ts`
 * and doc comments, not confirmed empirically here.
 */
export class ExpoSqliteDriver implements SqlDriver {
  constructor(private readonly db: SQLiteDatabase) {}

  // Every value flowing through `SqlDriver` is `unknown` by design (see `dexieStore.ts`'s
  // matching note) — every real caller only ever binds strings, numbers or null, but
  // `expo-sqlite`'s `SQLiteBindValue` type has no `unknown` case, so this widening is
  // documented with `as never` rather than papered over with a blanket `any`.
  async run(sql: string, params: readonly unknown[]): Promise<SqlRunResult> {
    const result = await this.db.runAsync(sql, params as never);
    return { changes: result.changes };
  }

  async runReturningId(sql: string, params: readonly unknown[]): Promise<number> {
    const result = await this.db.runAsync(sql, params as never);
    return result.lastInsertRowId;
  }

  async all<T = unknown>(sql: string, params: readonly unknown[]): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, params as never);
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // `withTransactionAsync`'s task returns `Promise<void>` — expo-sqlite doesn't thread a
    // result back out, so it's captured through this closure instead. A throw inside `fn` still
    // propagates out of `withTransactionAsync` and rolls the transaction back; nothing here
    // swallows it.
    let result: T | undefined;
    await this.db.withTransactionAsync(async () => {
      result = await fn();
    });
    return result as T;
  }
}

/** Creates every table and index this store needs. Idempotent — safe to call on every app start. */
export async function createSqliteSchema(db: SQLiteDatabase): Promise<void> {
  for (const schema of SQLITE_TABLE_SCHEMAS) {
    for (const statement of buildCreateStatements(schema)) {
      await db.execAsync(statement);
    }
  }
}
