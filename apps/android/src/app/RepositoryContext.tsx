import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import * as SQLite from 'expo-sqlite';
import type { Clock, IdGenerator } from '@medguard/shared';
import { MedGuardRepository, NotifyingStore } from '@medguard/store';
import { SqliteStore } from '@medguard/store/sqlite';
import { loadApiBaseUrlOverride } from '../api/config.js';
import { getOrCreateDeviceId } from '../identity/deviceId.js';
import { deviceClock, deviceIdGenerator } from '../runtime/deviceRuntime.js';
import { ExpoSqliteDriver, createSqliteSchema } from '../store/expoSqliteDriver.js';

/**
 * Composition root for the database and repository — the Android equivalent of
 * `apps/web/src/app/RepositoryContext.tsx`. Builds `expo-sqlite`'s database, the SQLite `Store`
 * from Sprint A1, wraps it in `NotifyingStore` (the reactivity primitive `useLiveQuery` reads —
 * see `src/store/useLiveQuery.ts`), and the one `MedGuardRepository` every screen writes through.
 *
 * Unlike web, this cannot be synchronous: opening the SQLite database and reading this device's
 * id (`expo-secure-store`, no synchronous API) are both async, so this provider renders a brief
 * loading state instead of building `handles` inline with `useMemo`. That's a real, deliberate
 * deviation from web's first-paint-ready behavior, not an oversight.
 */

interface RepositoryHandles {
  store: NotifyingStore;
  repository: MedGuardRepository;
  ids: IdGenerator;
  clock: Clock;
  userId: string;
  deviceId: string;
}

const RepositoryReactContext = createContext<RepositoryHandles | null>(null);

export function RepositoryProvider({
  userId,
  dbName = 'medguard.db',
  clock = deviceClock,
  children,
}: {
  userId: string;
  /** Overrides the default database file name — exists for test isolation, not production. */
  dbName?: string;
  /** Overrides the real device clock. Exists so tests can drive time deterministically. */
  clock?: Clock;
  children: ReactNode;
}) {
  const [handles, setHandles] = useState<RepositoryHandles | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      await loadApiBaseUrlOverride();
      const db = await SQLite.openDatabaseAsync(dbName);
      await createSqliteSchema(db);
      const store = new NotifyingStore(new SqliteStore(new ExpoSqliteDriver(db)));
      const deviceId = await getOrCreateDeviceId();
      const repository = new MedGuardRepository(store, {
        clock,
        ids: deviceIdGenerator,
        userId,
        deviceId,
      });

      if (!cancelled) {
        setHandles({ store, repository, ids: deviceIdGenerator, clock, userId, deviceId });
      }
    })();

    return () => {
      cancelled = true;
    };
    // userId changing mid-session (a caregiver switching identity on a shared device) is rare
    // enough, and consequential enough, that re-deriving the whole database handle rather than
    // patching it in place is the safer choice — same rationale as web's version.
  }, [userId, dbName, clock]);

  if (!handles) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator />
      </View>
    );
  }

  return <RepositoryReactContext.Provider value={handles}>{children}</RepositoryReactContext.Provider>;
}

function useHandles(): RepositoryHandles {
  const handles = useContext(RepositoryReactContext);
  if (!handles) {
    throw new Error('useRepository (and friends) must be used within a RepositoryProvider');
  }
  return handles;
}

export function useRepository(): MedGuardRepository {
  return useHandles().repository;
}

/** The `NotifyingStore` `useLiveQuery` subscribes to. Nothing else should read through this directly. */
export function useStore(): NotifyingStore {
  return useHandles().store;
}

/** For generating the id of a new entity before its first save. */
export function useIdGenerator(): IdGenerator {
  return useHandles().ids;
}

/** The injected clock — for computing "today"/"now" without ever calling `Date.now()` directly. */
export function useClock(): Clock {
  return useHandles().clock;
}

/** The caregiver name attached to writes this device makes — see identity/caregiverName.ts. */
export function useCurrentUserId(): string {
  return useHandles().userId;
}

/** This device's stable id — see identity/deviceId.ts. */
export function useCurrentDeviceId(): string {
  return useHandles().deviceId;
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
