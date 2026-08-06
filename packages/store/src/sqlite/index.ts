export { SqliteStore } from './sqliteStore.js';
export { SQLITE_TABLE_SCHEMAS, buildCreateStatements, findTableSchema } from './schema.js';
export type { SqliteTableSchema } from './schema.js';
export type { SqlDriver, SqlRunResult } from './sqlDriver.js';
/** Node-only (needs `better-sqlite3`, an optional peer dependency) — for tests, and for any
 * future non-Android target that wants this same `Store` on plain Node rather than Android's
 * `expo-sqlite`. Android imports `SqliteStore` above directly with its own driver instead. */
export { BetterSqliteDriver, createSqliteSchema } from './betterSqliteDriver.js';
