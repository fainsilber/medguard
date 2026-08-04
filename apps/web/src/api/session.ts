/**
 * The device's credential for its household, persisted locally.
 *
 * This is the one piece of state that outlives everything else: lose it and the device has to be
 * re-invited with a fresh join code, because the server keeps only a hash and cannot hand the
 * token back.
 *
 * Kept in localStorage alongside the device id and caregiver name rather than in IndexedDB, so
 * reading it never has to be async — the app needs to know on first paint whether it belongs to a
 * household yet.
 */
const STORAGE_KEY = 'medguard-household-session';

/**
 * Fired whenever the stored session changes, so code outside whatever component made the change
 * (the sync engine, in particular — see apps/web/src/sync/SyncProvider.tsx) can react without a
 * shared React context. `HouseholdScreen` already funnels every connect/leave/delete/switch
 * action through `setHouseholdSession`/`clearHouseholdSession` below, so this one dispatch point
 * covers all of them for free.
 */
const SESSION_CHANGE_EVENT = 'medguard:household-session-changed';

export interface HouseholdSession {
  deviceToken: string;
  householdId: string;
  userId: string;
  deviceId: string;
  householdName?: string;
}

export function getHouseholdSession(): HouseholdSession | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as HouseholdSession).deviceToken === 'string' &&
      typeof (parsed as HouseholdSession).householdId === 'string'
    ) {
      return parsed as HouseholdSession;
    }
    return null;
  } catch {
    // Corrupt entry: treat as absent rather than throwing on startup and bricking the app.
    return null;
  }
}

export function setHouseholdSession(session: HouseholdSession): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  window.dispatchEvent(new Event(SESSION_CHANGE_EVENT));
}

export function clearHouseholdSession(): void {
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(SESSION_CHANGE_EVENT));
}

/** Subscribes to session changes; returns an unsubscribe function. */
export function onHouseholdSessionChange(listener: () => void): () => void {
  window.addEventListener(SESSION_CHANGE_EVENT, listener);
  return () => window.removeEventListener(SESSION_CHANGE_EVENT, listener);
}
