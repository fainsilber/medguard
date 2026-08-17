/**
 * The SQLite mirror of `apps/web/src/db/schema.ts`'s Dexie index list — but only the columns an
 * `IndexQuery` in `repository.ts` actually reads. Every record is stored whole as JSON in `data`;
 * `indexedFields` are denormalized copies kept in their own columns purely so SQLite can build a
 * real index over them, the same reason Dexie's schema names the same fields.
 *
 * `shabbatConfig` and `shabbatWindows` have no indexed fields despite being real synced tables —
 * nothing in `MedGuardRepository` ever runs an `IndexQuery` against either, only `get`/`put`/
 * `getAll`, which every table supports with no indexed columns at all.
 */

export interface SqliteTableSchema {
  name: string;
  /** The primary-key column. `'id'` everywhere except `syncOutbox` (still `'id'`, but integer
   * and auto-incrementing) and `syncMeta` (`'key'`). */
  pk: string;
  pkIsInteger?: boolean;
  /** Extra columns, mirrored out of the JSON `data` blob on every write, that a real `IndexQuery`
   * reads from — each queryable field needs a real SQL column to be indexed on. */
  indexedFields: string[];
}

export const SQLITE_TABLE_SCHEMAS: readonly SqliteTableSchema[] = [
  { name: 'householdSettings', pk: 'id', indexedFields: [] },
  { name: 'patients', pk: 'id', indexedFields: [] },
  { name: 'medicinePatients', pk: 'id', indexedFields: ['medicineId', 'patientId'] },
  { name: 'medicines', pk: 'id', indexedFields: [] },
  { name: 'schedules', pk: 'id', indexedFields: ['medicineId'] },
  { name: 'intakeLogs', pk: 'id', indexedFields: ['medicineId', 'patientId', 'actualTime'] },
  { name: 'inventoryItems', pk: 'id', indexedFields: ['medicineId'] },
  { name: 'inventoryAdjustments', pk: 'id', indexedFields: ['medicineId', 'relatedLogId'] },
  { name: 'doseSnoozes', pk: 'id', indexedFields: ['occurrenceId', 'createdAt'] },
  { name: 'shabbatConfig', pk: 'id', indexedFields: [] },
  // Sprint A5. Read whole (`allShabbatWindows`) rather than queried: a rolling 90-day horizon is
  // a few dozen rows, and which of them matter is decided by `@medguard/shared`'s predicates so
  // that every surface applies the same boundary rule.
  { name: 'shabbatWindows', pk: 'id', indexedFields: [] },
  { name: 'syncOutbox', pk: 'id', pkIsInteger: true, indexedFields: ['table', 'createdAt'] },
  { name: 'syncMeta', pk: 'key', indexedFields: [] },
];

export function findTableSchema(table: string): SqliteTableSchema {
  const schema = SQLITE_TABLE_SCHEMAS.find((t) => t.name === table);
  if (!schema) {
    throw new Error(`Unknown table for the SQLite store: ${table}`);
  }
  return schema;
}

function quoteIdent(name: string): string {
  return `"${name}"`;
}

/** CREATE TABLE + CREATE INDEX statements — idempotent, safe to run on every app start. */
export function buildCreateStatements(schema: SqliteTableSchema): string[] {
  const pkType = schema.pkIsInteger ? 'INTEGER' : 'TEXT';
  const pkClause = schema.pkIsInteger
    ? `${quoteIdent(schema.pk)} ${pkType} PRIMARY KEY AUTOINCREMENT`
    : `${quoteIdent(schema.pk)} ${pkType} PRIMARY KEY`;
  const extraColumns = schema.indexedFields
    .filter((field) => field !== schema.pk)
    .map((field) => `, ${quoteIdent(field)} TEXT`)
    .join('');

  const statements = [
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(schema.name)} (${pkClause}, data TEXT NOT NULL${extraColumns})`,
  ];

  for (const field of schema.indexedFields) {
    if (field === schema.pk) continue;
    statements.push(
      `CREATE INDEX IF NOT EXISTS ${quoteIdent(`idx_${schema.name}_${field}`)} ON ${quoteIdent(schema.name)} (${quoteIdent(field)})`,
    );
  }

  return statements;
}
