import type Dexie from 'dexie';
import type { IndexQuery, RecordId, Store, StoreTransaction } from '../types.js';

/**
 * The web `Store`: a thin adapter over an existing Dexie database, not a new one.
 *
 * Deliberately generic over `Dexie` rather than importing `apps/web`'s concrete `MedGuardDB`
 * subclass — `packages/store` must not depend on an app. `apps/web` passes its real `MedGuardDB`
 * instance in, and everything that reads through it directly for `useLiveQuery` reactivity
 * (dexie-react-hooks) keeps working unchanged, because this wraps the same instance rather than
 * replacing it.
 *
 * Dexie transactions are ambient (ANY `db.table(x).method()` call made synchronously within the
 * scope of `db.transaction(...)` joins it automatically, regardless of which `Table` reference is
 * used to make the call) — so a single `DexieTransaction` bound to `db` is correct for every
 * `transaction()` call, not one instantiated per call.
 *
 * `TDB extends Dexie` rather than a bare `Dexie` parameter type: Dexie's `transaction()` overload
 * types its callback with `TXWithTables<this>`, and asking TypeScript to prove a concrete
 * subclass (e.g. `MedGuardDB`) is assignable to the plain `Dexie` base — which a bare parameter
 * type would require at every call site — recurses deep enough to hit "Type instantiation is
 * excessively deep" (TS2589). Staying generic means the concrete subclass flows through as
 * itself and that comparison never has to happen.
 */

function indexName(fields: readonly string[]): string {
  return fields.length === 1 ? fields[0]! : `[${fields.join('+')}]`;
}

class DexieTransaction<TDB extends Dexie> implements StoreTransaction {
  constructor(private readonly db: TDB) {}

  async get<T>(table: string, id: RecordId): Promise<T | undefined> {
    return this.db.table(table).get(id);
  }

  async getAll<T>(table: string): Promise<T[]> {
    return this.db.table(table).toArray();
  }

  async put<T>(table: string, record: T): Promise<void> {
    await this.db.table(table).put(record);
  }

  async bulkPut<T>(table: string, records: T[]): Promise<void> {
    await this.db.table(table).bulkPut(records);
  }

  async append<T>(table: string, record: T): Promise<number> {
    return this.db.table(table).add(record) as Promise<number>;
  }

  async update<T>(table: string, id: RecordId, changes: Partial<T>): Promise<void> {
    await this.db.table(table).update(id, changes);
  }

  async delete(table: string, id: RecordId): Promise<void> {
    await this.db.table(table).delete(id);
  }

  async clear(table: string): Promise<void> {
    await this.db.table(table).clear();
  }

  async count(table: string): Promise<number> {
    return this.db.table(table).count();
  }

  // Every value flowing through `IndexQuery` is `unknown` by design (the Store contract has no
  // opinion on field types), but Dexie's `.equals()`/`.anyOf()`/`.between()` want its own
  // `IndexableType`. Every real caller only ever passes strings (ids, ISO timestamps, table
  // names) — see `types.ts`'s `IndexQuery` doc — so this is a widening the type system can't see
  // through on its own, not an actual type hole; `as never` documents that rather than hiding it
  // behind a blanket `any`.
  async queryIndex<T>(table: string, query: IndexQuery): Promise<T[]> {
    const t = this.db.table(table);
    switch (query.kind) {
      case 'equals':
        return t
          .where(indexName(query.fields))
          .equals((query.fields.length === 1 ? query.values[0] : query.values) as never)
          .toArray();
      case 'anyOf':
        return t.where(query.fields[0]).anyOf(query.values as never[]).toArray();
      case 'range': {
        const name = indexName(query.fields);
        const lowerKey = query.prefix.length > 0 ? [...query.prefix, query.lower] : query.lower;
        const upperKey = query.prefix.length > 0 ? [...query.prefix, query.upper] : query.upper;
        return t.where(name).between(lowerKey as never, upperKey as never, true, true).toArray();
      }
      case 'all':
        return t.orderBy(query.orderBy).toArray();
    }
  }
}

export class DexieStore<TDB extends Dexie = Dexie> implements Store {
  private readonly tx: DexieTransaction<TDB>;

  constructor(private readonly db: TDB) {
    this.tx = new DexieTransaction(db);
  }

  transaction<T>(tables: readonly string[], fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    return this.db.transaction('rw', [...tables], () => fn(this.tx));
  }
}
