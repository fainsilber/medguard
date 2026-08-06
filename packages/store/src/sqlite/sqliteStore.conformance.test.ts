import Database from 'better-sqlite3';
import { runRepositoryConformanceSuite } from '../testing/repositoryConformance.js';
import { BetterSqliteDriver, createSqliteSchema } from './betterSqliteDriver.js';
import { SqliteStore } from './sqliteStore.js';

runRepositoryConformanceSuite('SQLite', () => {
  const db = new Database(':memory:');
  createSqliteSchema(db);
  return new SqliteStore(new BetterSqliteDriver(db));
});
