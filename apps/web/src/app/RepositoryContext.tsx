import { createContext, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { systemClock, uuidIdGenerator } from '@medguard/shared';
import type { Clock, IdGenerator } from '@medguard/shared';
import { MedGuardRepository } from '@medguard/store';
import { DexieStore } from '@medguard/store/dexie';
import type { Store } from '@medguard/store';
import { requestPersistentStorage } from '../db/persist.js';
import { MedGuardDB } from '../db/schema.js';
import { getOrCreateDeviceId } from '../identity/deviceId.js';

/**
 * Composition root for the database and repository: the one place the real system clock and
 * real device id are constructed and handed downward, matching the pattern established in
 * main.tsx and packages/shared/src/clock.ts. Everything below this reads time and identity only
 * through what it's given, never ambiently.
 *
 * `ids`, `clock`, `userId` and `deviceId` are exposed alongside `db` and `repository`: several
 * repository methods (`recordDose`, `correctDose`, `saveHouseholdSettings`, …) take a
 * fully-formed entity rather than filling in attribution themselves, so feature code needs the
 * sanctioned way to read "who is this" and "what time is it" without reaching for
 * `crypto.randomUUID()` or `Date.now()` directly — both forbidden under src/features/ by the
 * no-ambient-time / no-ambient-identity lint rule.
 */

interface RepositoryHandles {
  db: MedGuardDB;
  store: Store;
  repository: MedGuardRepository;
  ids: IdGenerator;
  clock: Clock;
  userId: string;
  deviceId: string;
}

const RepositoryReactContext = createContext<RepositoryHandles | null>(null);

export function RepositoryProvider({
  userId,
  dbName,
  clock = systemClock,
  children,
}: {
  userId: string;
  /** Overrides the default database name — exists for test isolation, not a production concern. */
  dbName?: string;
  /**
   * Overrides the real system clock. Exists so tests can drive time deterministically — the
   * sprint plan requires RTL tests for the PRN screen "under a fake clock": countdown rendering,
   * the locked→unlocked flip at the exact boundary, the cap boundary at 23h59m vs 24h01m. None
   * of that is reliably testable against the real clock.
   */
  clock?: Clock;
  children: ReactNode;
}) {
  const handles = useMemo<RepositoryHandles>(() => {
    const db = new MedGuardDB(dbName);
    const store = new DexieStore(db);
    const deviceId = getOrCreateDeviceId();
    const repository = new MedGuardRepository(store, { clock, ids: uuidIdGenerator, userId, deviceId });
    return { db, store, repository, ids: uuidIdGenerator, clock, userId, deviceId };
    // userId changing mid-session (a caregiver switching identity on a shared device) is rare
    // enough, and consequential enough, that re-deriving the whole database handle rather than
    // patching it in place is the safer choice — no risk of a write landing attributed to the
    // wrong person because a memoised value went stale.
  }, [userId, dbName, clock]);

  useEffect(() => {
    void requestPersistentStorage();
  }, []);

  return (
    <RepositoryReactContext.Provider value={handles}>{children}</RepositoryReactContext.Provider>
  );
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

/** For read-only live queries via dexie-react-hooks, which query the database directly. */
export function useMedGuardDb(): MedGuardDB {
  return useHandles().db;
}

/** The storage-agnostic port the sync engine (and nothing else) writes through. */
export function useStore(): Store {
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
