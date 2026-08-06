import type { IndexQuery, RecordId, Store, StoreTransaction } from '../types.js';
import type { SqlDriver } from './sqlDriver.js';
import { findTableSchema, type SqliteTableSchema } from './schema.js';

/**
 * The Android (and Node-test) `Store`: every record stored whole as JSON in a `data` column, with
 * the handful of fields a real `IndexQuery` reads mirrored into their own indexed columns (see
 * `schema.ts`). Behind `SqlDriver` so the same query-building logic runs against `better-sqlite3`
 * in tests and `expo-sqlite` on device — see `sqlDriver.ts`.
 */

function quoteIdent(name: string): string {
  return `"${name}"`;
}

function assertIndexed(schema: SqliteTableSchema, fields: readonly string[]): void {
  for (const field of fields) {
    if (field !== schema.pk && !schema.indexedFields.includes(field)) {
      throw new Error(
        `"${field}" is not an indexed column on "${schema.name}" — add it to SQLITE_TABLE_SCHEMAS in schema.ts.`,
      );
    }
  }
}

function parseRow<T>(row: { data: string }): T {
  return JSON.parse(row.data) as T;
}

function indexedColumnValues(schema: SqliteTableSchema, record: Record<string, unknown>): unknown[] {
  return schema.indexedFields
    .filter((field) => field !== schema.pk)
    .map((field) => {
      const value = record[field];
      return value === undefined || value === null ? null : String(value);
    });
}

class SqliteTransaction implements StoreTransaction {
  constructor(private readonly driver: SqlDriver) {}

  async get<T>(table: string, id: RecordId): Promise<T | undefined> {
    const schema = findTableSchema(table);
    const rows = await this.driver.all<{ data: string }>(
      `SELECT data FROM ${quoteIdent(table)} WHERE ${quoteIdent(schema.pk)} = ?`,
      [id],
    );
    return rows[0] === undefined ? undefined : parseRow<T>(rows[0]);
  }

  async getAll<T>(table: string): Promise<T[]> {
    const rows = await this.driver.all<{ data: string }>(`SELECT data FROM ${quoteIdent(table)}`, []);
    return rows.map((row) => parseRow<T>(row));
  }

  async put<T>(table: string, record: T): Promise<void> {
    const schema = findTableSchema(table);
    const rec = record as unknown as Record<string, unknown>;
    const extraCols = schema.indexedFields.filter((f) => f !== schema.pk);
    const columnNames = [schema.pk, 'data', ...extraCols].map(quoteIdent).join(', ');
    const placeholders = Array(2 + extraCols.length).fill('?').join(', ');
    const updateSet = ['data = excluded.data', ...extraCols.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`)].join(
      ', ',
    );
    const params = [rec[schema.pk], JSON.stringify(record), ...indexedColumnValues(schema, rec)];
    await this.driver.run(
      `INSERT INTO ${quoteIdent(table)} (${columnNames}) VALUES (${placeholders}) ` +
        `ON CONFLICT(${quoteIdent(schema.pk)}) DO UPDATE SET ${updateSet}`,
      params,
    );
  }

  async bulkPut<T>(table: string, records: T[]): Promise<void> {
    for (const record of records) {
      await this.put(table, record);
    }
  }

  async append<T>(table: string, record: T): Promise<number> {
    const schema = findTableSchema(table);
    if (!schema.pkIsInteger) {
      throw new Error(`append() is only valid for auto-incrementing tables; "${table}" is not one.`);
    }
    const extraCols = schema.indexedFields.filter((f) => f !== schema.pk);
    const rec = record as unknown as Record<string, unknown>;
    const columnNames = ['data', ...extraCols].map(quoteIdent).join(', ');
    const placeholders = Array(1 + extraCols.length).fill('?').join(', ');
    const params = [JSON.stringify(record), ...indexedColumnValues(schema, rec)];
    const id = await this.driver.runReturningId(
      `INSERT INTO ${quoteIdent(table)} (${columnNames}) VALUES (${placeholders})`,
      params,
    );
    // Dexie assigns an inbound auto-increment key onto the stored record itself (`record.id`
    // reads back populated after `.add()`); a raw SQLite AUTOINCREMENT doesn't, so the id has to
    // be folded back into the stored JSON in a second write to match that behavior — every reader
    // of a `SyncOutboxEntry` (`markSynced`, `markSyncFailed`) expects `.id` to already be there.
    await this.driver.run(`UPDATE ${quoteIdent(table)} SET data = ? WHERE ${quoteIdent(schema.pk)} = ?`, [
      JSON.stringify({ ...record, [schema.pk]: id }),
      id,
    ]);
    return id;
  }

  async update<T>(table: string, id: RecordId, changes: Partial<T>): Promise<void> {
    const existing = await this.get<T>(table, id);
    if (existing === undefined) {
      return;
    }
    await this.put(table, { ...existing, ...changes });
  }

  async delete(table: string, id: RecordId): Promise<void> {
    const schema = findTableSchema(table);
    await this.driver.run(`DELETE FROM ${quoteIdent(table)} WHERE ${quoteIdent(schema.pk)} = ?`, [id]);
  }

  async clear(table: string): Promise<void> {
    await this.driver.run(`DELETE FROM ${quoteIdent(table)}`, []);
  }

  async count(table: string): Promise<number> {
    const rows = await this.driver.all<{ c: number }>(`SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`, []);
    return rows[0]?.c ?? 0;
  }

  async queryIndex<T>(table: string, query: IndexQuery): Promise<T[]> {
    const schema = findTableSchema(table);

    if (query.kind === 'equals') {
      assertIndexed(schema, query.fields);
      const where = query.fields.map((f) => `${quoteIdent(f)} = ?`).join(' AND ');
      const rows = await this.driver.all<{ data: string }>(
        `SELECT data FROM ${quoteIdent(table)} WHERE ${where}`,
        query.values,
      );
      return rows.map((row) => parseRow<T>(row));
    }

    if (query.kind === 'anyOf') {
      assertIndexed(schema, query.fields);
      const placeholders = query.values.map(() => '?').join(', ');
      const rows = await this.driver.all<{ data: string }>(
        `SELECT data FROM ${quoteIdent(table)} WHERE ${quoteIdent(query.fields[0])} IN (${placeholders})`,
        query.values,
      );
      return rows.map((row) => parseRow<T>(row));
    }

    if (query.kind === 'range') {
      assertIndexed(schema, query.fields);
      const prefixFields = query.fields.slice(0, -1);
      const rangeField = query.fields[query.fields.length - 1]!;
      const whereParts = [...prefixFields.map((f) => `${quoteIdent(f)} = ?`), `${quoteIdent(rangeField)} BETWEEN ? AND ?`];
      const params = [...query.prefix, query.lower, query.upper];
      const rows = await this.driver.all<{ data: string }>(
        `SELECT data FROM ${quoteIdent(table)} WHERE ${whereParts.join(' AND ')}`,
        params,
      );
      return rows.map((row) => parseRow<T>(row));
    }

    // query.kind === 'all'
    assertIndexed(schema, [query.orderBy]);
    const rows = await this.driver.all<{ data: string }>(
      `SELECT data FROM ${quoteIdent(table)} ORDER BY ${quoteIdent(query.orderBy)} ASC`,
      [],
    );
    return rows.map((row) => parseRow<T>(row));
  }
}

export class SqliteStore implements Store {
  private readonly tx: SqliteTransaction;

  constructor(private readonly driver: SqlDriver) {
    this.tx = new SqliteTransaction(driver);
  }

  transaction<T>(_tables: readonly string[], fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    return this.driver.withTransaction(() => fn(this.tx));
  }
}
