import Database from 'better-sqlite3';

/**
 * Jest mock for `expo-sqlite` (mapped in `jest.config.js`), so component tests that render
 * `RepositoryProvider` get a real, working SQLite database instead of `expo-sqlite`'s actual
 * native module, which has no device to run on under Jest (`NativeDatabase is not a
 * constructor`). Backed by `better-sqlite3` — the same substitution
 * `src/store/offlineFlow.test.ts` already makes under Vitest for the identical reason, via
 * `BetterSqliteDriver` in `packages/store/src/sqlite/`. This mock only needs to satisfy
 * `ExpoSqliteDriver`'s and `createSqliteSchema`'s actual call surface
 * (`execAsync`/`runAsync`/`getAllAsync`/`withTransactionAsync`), not the full `SQLiteDatabase`
 * API — real `expo-sqlite` on a device is still the only thing that proves this app's actual
 * on-device behavior (see `apps/android/README.md`, "What hasn't been verified").
 */

interface MockSqliteDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: unknown[]): Promise<{ changes: number; lastInsertRowId: number }>;
  getAllAsync<T>(sql: string, params: unknown[]): Promise<T[]>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
}

export function openDatabaseAsync(_name: string): Promise<MockSqliteDatabase> {
  const db = new Database(':memory:');

  const mockDb: MockSqliteDatabase = {
    async execAsync(sql) {
      db.exec(sql);
    },
    async runAsync(sql, params) {
      const info = db.prepare(sql).run(...(params as never[]));
      return { changes: info.changes, lastInsertRowId: Number(info.lastInsertRowid) };
    },
    async getAllAsync<T>(sql: string, params: unknown[]) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async withTransactionAsync(fn) {
      // better-sqlite3's own transactions are synchronous; `fn` here is async (it awaits driver
      // calls that immediately resolve), so this runs it directly rather than wrapping a real
      // BEGIN/COMMIT — good enough for rendering tests, which don't exercise rollback-on-throw
      // (that's real coverage, under Vitest, in packages/store's own transaction tests).
      await fn();
    },
  };

  return Promise.resolve(mockDb);
}
