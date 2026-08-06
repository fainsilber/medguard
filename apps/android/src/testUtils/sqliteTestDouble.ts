import Database from 'better-sqlite3';

/**
 * A stand-in for `expo-sqlite`'s async database API, for Jest component tests.
 *
 * Jest cannot run `expo-sqlite`'s real native module — there is no Android SDK, emulator, or
 * device in this sandbox (see `apps/android/README.md`, "What hasn't been verified"; the same
 * gap `apps/android/src/store/offlineFlow.test.ts` documents for pure-logic tests). Attempting to
 * import `expo-sqlite` under `jest-expo`'s generic native-module mocking throws (`NativeDatabase
 * is not a constructor`) rather than doing anything useful.
 *
 * `renderWithRepository.tsx` substitutes this module for `expo-sqlite` via `jest.mock`, so
 * `RepositoryProvider`'s own `SQLite.openDatabaseAsync(...)` call resolves to a real, working
 * database — just backed by `better-sqlite3` (already a devDependency, used the same way by
 * `offlineFlow.test.ts`) instead of the native binding. Every other line of production code
 * (`ExpoSqliteDriver`, `createSqliteSchema`, `SqliteStore`, `MedGuardRepository`) runs completely
 * unmodified against it, so this only swaps out the one thing that cannot run here.
 */

const databases = new Map<string, Database.Database>();

function rawDatabase(name: string): Database.Database {
  let db = databases.get(name);
  if (!db) {
    db = new Database(':memory:');
    databases.set(name, db);
  }
  return db;
}

function asParamsArray(params: readonly unknown[] | undefined): unknown[] {
  return params ? (params as unknown[]) : [];
}

export interface FakeSQLiteDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ changes: number; lastInsertRowId: number }>;
  getAllAsync<T>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

function wrap(db: Database.Database): FakeSQLiteDatabase {
  return {
    async execAsync(sql: string) {
      db.exec(sql);
    },
    async runAsync(sql: string, params?: readonly unknown[]) {
      const result = db.prepare(sql).run(...asParamsArray(params));
      return { changes: result.changes, lastInsertRowId: Number(result.lastInsertRowid) };
    },
    async getAllAsync<T>(sql: string, params?: readonly unknown[]) {
      return db.prepare(sql).all(...asParamsArray(params)) as T[];
    },
    async withTransactionAsync(task: () => Promise<void>) {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

/** The shape `RepositoryContext.tsx` calls through `import * as SQLite from 'expo-sqlite'`. */
export async function openDatabaseAsync(name: string): Promise<FakeSQLiteDatabase> {
  return wrap(rawDatabase(name));
}

/**
 * For pre-seeding data before a component mounts. Returns the *same* underlying database
 * `openDatabaseAsync` above will hand to the component under test (keyed by name), so a seed
 * write is visible to the rendered component and vice versa.
 */
export function rawDatabaseForSeeding(name: string): Database.Database {
  return rawDatabase(name);
}
