import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { systemClock, uuidIdGenerator } from '@medguard/shared';
import type { Clock, IdGenerator } from '@medguard/shared';
import { AndroidRepository } from '../db/repository.js';
import { AndroidMedGuardDB } from '../db/schema.js';
import { getOrCreateDeviceId } from '../runtime/deviceId.js';

/**
 * Composition root for the database and repository, mirroring
 * `apps/web/src/app/RepositoryContext.tsx`: the one place the real system clock and real device
 * id are constructed and handed downward. Everything below this reads time and identity only
 * through what it is given, never ambiently — which is what makes cooldown boundaries and DST
 * transitions testable without waiting for a calendar.
 */

interface AndroidAppHandles {
  db: AndroidMedGuardDB;
  repository: AndroidRepository;
  ids: IdGenerator;
  clock: Clock;
  userId: string;
  deviceId: string;
}

const AndroidAppContext = createContext<AndroidAppHandles | null>(null);

export function AndroidAppProvider({
  userId,
  dbName,
  clock = systemClock,
  children,
}: {
  userId: string;
  /** Overrides the default database name — exists for test isolation, not a production concern. */
  dbName?: string;
  /** Overrides the real system clock, so tests can drive cooldowns and caps deterministically. */
  clock?: Clock;
  children: ReactNode;
}) {
  const handles = useMemo<AndroidAppHandles>(() => {
    const db = new AndroidMedGuardDB(dbName);
    const deviceId = getOrCreateDeviceId();
    const repository = new AndroidRepository(db, {
      clock,
      ids: uuidIdGenerator,
      userId,
      deviceId,
    });
    return { db, repository, ids: uuidIdGenerator, clock, userId, deviceId };
    // Re-deriving the whole handle when the caregiver changes, rather than patching it, removes
    // any risk of a write landing attributed to the wrong person via a stale memo.
  }, [userId, dbName, clock]);

  return <AndroidAppContext.Provider value={handles}>{children}</AndroidAppContext.Provider>;
}

function useHandles(): AndroidAppHandles {
  const handles = useContext(AndroidAppContext);
  if (!handles) {
    throw new Error('useRepository (and friends) must be used within an AndroidAppProvider');
  }
  return handles;
}

export function useRepository(): AndroidRepository {
  return useHandles().repository;
}

/** For read-only live queries via dexie-react-hooks, which query the database directly. */
export function useMedGuardDb(): AndroidMedGuardDB {
  return useHandles().db;
}

/** For generating the id of a new entity before its first save. */
export function useIdGenerator(): IdGenerator {
  return useHandles().ids;
}

/** The injected clock — for computing "now" without ever calling `Date.now()` directly. */
export function useClock(): Clock {
  return useHandles().clock;
}

/** The caregiver name attached to writes this device makes. */
export function useCurrentUserId(): string {
  return useHandles().userId;
}

/** This device's stable id. */
export function useCurrentDeviceId(): string {
  return useHandles().deviceId;
}
