import type { IndexQuery, RecordId, Store, StoreTransaction } from './types.js';

export type StoreChangeListener = (tables: readonly string[]) => void;

/**
 * Wraps a `Store` and emits a change notification after a `transaction()` commit that actually
 * wrote something — the reactivity primitive Dexie gives web for free (`dexie-react-hooks`'s
 * `useLiveQuery`) and `expo-sqlite` gives Android nothing for at all (docs/android-client-plan.md,
 * "Storage and the sync port").
 *
 * `transaction(tables, fn)` is the *only* entry point on `Store` — every read and write in this
 * package goes through it (`MedGuardRepository`, and `tableDispatch.ts` applying pulled records
 * during a sync pull) — so wrapping it here is a single choke point that sees every mutation,
 * local or synced, without either caller needing to know this exists.
 *
 * **Must** distinguish a read from a write, not just notify on every commit: `useLiveQuery`
 * subscribes to the same tables it queries, so a naively "notify on every transaction" version
 * makes every read re-trigger its own subscription — an infinite, synchronous-ish feedback loop
 * between "query" and "notify," confirmed the hard way (a component test spun one CPU core at
 * 100% until OOM before this was caught). So `transaction()` here wraps the inner `tx` to track
 * whether any mutating method (`put`/`bulkPut`/`append`/`update`/`delete`/`clear`) was actually
 * called, and only emits when one was — `get`/`getAll`/`queryIndex`/`count` alone never notify.
 */
export class NotifyingStore implements Store {
  private readonly listeners = new Set<{ tables: readonly string[]; listener: StoreChangeListener }>();

  constructor(private readonly inner: Store) {}

  async transaction<T>(tables: readonly string[], fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    let wrote = false;
    const trackedTx = trackWrites(fn, () => {
      wrote = true;
    });
    const result = await this.inner.transaction(tables, trackedTx);
    if (wrote) {
      this.emit(tables);
    }
    return result;
  }

  /** Notifies `listener` whenever a transaction that wrote something touches any table in `tables`. */
  subscribe(tables: readonly string[], listener: StoreChangeListener): () => void {
    const entry = { tables, listener };
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  private emit(tables: readonly string[]): void {
    for (const { tables: watched, listener } of this.listeners) {
      if (watched.some((table) => tables.includes(table))) {
        listener(tables);
      }
    }
  }
}

/** Wraps `fn`'s `tx` argument so every write method flips `markWrite`, then delegates to the real one. */
function trackWrites<T>(
  fn: (tx: StoreTransaction) => Promise<T>,
  markWrite: () => void,
): (tx: StoreTransaction) => Promise<T> {
  return (tx: StoreTransaction) => fn(wrapTransaction(tx, markWrite));
}

function wrapTransaction(tx: StoreTransaction, markWrite: () => void): StoreTransaction {
  return {
    get: <T>(table: string, id: RecordId) => tx.get<T>(table, id),
    getAll: <T>(table: string) => tx.getAll<T>(table),
    queryIndex: <T>(table: string, query: IndexQuery) => tx.queryIndex<T>(table, query),
    count: (table: string) => tx.count(table),
    put: <T>(table: string, record: T) => {
      markWrite();
      return tx.put(table, record);
    },
    bulkPut: <T>(table: string, records: T[]) => {
      markWrite();
      return tx.bulkPut(table, records);
    },
    append: <T>(table: string, record: T) => {
      markWrite();
      return tx.append(table, record);
    },
    update: <T>(table: string, id: RecordId, changes: Partial<T>) => {
      markWrite();
      return tx.update(table, id, changes);
    },
    delete: (table: string, id: RecordId) => {
      markWrite();
      return tx.delete(table, id);
    },
    clear: (table: string) => {
      markWrite();
      return tx.clear(table);
    },
  };
}
