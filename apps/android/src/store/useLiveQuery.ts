import { useEffect, useRef, useState } from 'react';
import { useStore } from '../app/RepositoryContext.js';

/**
 * The RN-side analogue of Dexie's `useLiveQuery(fn, [db])`, which the whole web UI is built on.
 * `expo-sqlite`/`SqliteStore` has no change notification of its own
 * (docs/android-client-plan.md, "Storage and the sync port"), so this reads through the
 * `NotifyingStore` the composition root wraps every store in (`packages/store/src/notifyingStore.ts`)
 * instead: run `queryFn` once, then again whenever a transaction touches any table in
 * `watchTables` — a local write through `MedGuardRepository` or a synced write applied by
 * `SyncEngine`'s pull, both funnel through the same wrapped `transaction()`.
 *
 * `watchTables` should be a literal, stable-length array at each call site (`['medicines']`,
 * `['schedules', 'syncOutbox']`) — its *values* are compared, not its identity, so a literal is
 * fine even though it's a new array each render.
 *
 * `queryFn` closing over a value that isn't a table (the multi-patient switcher's
 * `filterPatientId`, say) will *not* re-run on its own: nothing about a screen re-rendering makes
 * `run()` fire again, only a subscribed table write or `watchTables` itself changing does. For a
 * query whose *result* should also change when such a value does, pass it in the optional third
 * `deps` array — compared like a normal `useEffect` dependency list — rather than relying on the
 * closure alone. (Most call sites instead fetch unfiltered and filter the result in a separate
 * `useMemo`, which sidesteps this entirely; `deps` is for the few where refetching is the natural
 * shape, such as `ShabbatScreen`'s per-patient config.)
 */
export function useLiveQuery<T>(
  queryFn: () => Promise<T>,
  watchTables: readonly string[],
  deps: readonly unknown[] = [],
): T | undefined {
  const store = useStore();
  const [value, setValue] = useState<T | undefined>(undefined);
  const queryFnRef = useRef(queryFn);
  queryFnRef.current = queryFn;

  const tablesKey = watchTables.join(',');

  useEffect(() => {
    let cancelled = false;

    const run = () => {
      queryFnRef.current().then((result) => {
        if (!cancelled) {
          setValue(result);
        }
      });
    };

    run();
    const unsubscribe = store.subscribe(tablesKey === '' ? [] : tablesKey.split(','), run);

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // tablesKey is the real dependency; queryFn is read through the ref above rather than listed
    // here, so a screen passing a fresh closure each render doesn't re-subscribe every render —
    // except for whatever the caller explicitly opted into via `deps`.
  }, [store, tablesKey, ...deps]);

  return value;
}
