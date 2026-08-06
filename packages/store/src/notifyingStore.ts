import type { Store, StoreTransaction } from './types.js';

export type StoreChangeListener = (tables: readonly string[]) => void;

/**
 * Wraps a `Store` and emits a change notification after every `transaction()` commit — the
 * reactivity primitive Dexie gives web for free (`dexie-react-hooks`' `useLiveQuery`) and
 * `expo-sqlite` gives Android nothing for at all (docs/android-client-plan.md, "Storage and the
 * sync port").
 *
 * `transaction(tables, fn)` is the *only* entry point on `Store` — every read and write in this
 * package goes through it (`MedGuardRepository`, and `tableDispatch.ts` applying pulled records
 * during a sync pull) — so wrapping it here is a single choke point that sees every mutation,
 * local or synced, without either caller needing to know this exists.
 *
 * Deliberately coarse: a read-only `transaction()` call still emits (there's no way to tell
 * "wrote nothing" from "wrote something" without inspecting every operation inside `fn`), so a
 * subscriber occasionally re-fetches for no reason. That's a wasted query, not a correctness bug,
 * and simplicity here matters more than shaving it — the alternative is tracking writes inside
 * `StoreTransaction` itself, which would leak this concern into every `Store` implementation
 * instead of costing nothing anywhere but here.
 */
export class NotifyingStore implements Store {
  private readonly listeners = new Set<{ tables: readonly string[]; listener: StoreChangeListener }>();

  constructor(private readonly inner: Store) {}

  async transaction<T>(tables: readonly string[], fn: (tx: StoreTransaction) => Promise<T>): Promise<T> {
    const result = await this.inner.transaction(tables, fn);
    this.emit(tables);
    return result;
  }

  /** Notifies `listener` whenever a transaction touches any table in `tables`. */
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
