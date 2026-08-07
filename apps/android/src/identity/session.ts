import * as SecureStore from 'expo-secure-store';

/**
 * The device's credential for its household, persisted locally — the Android equivalent of
 * `apps/web/src/api/session.ts`, backed by `expo-secure-store` instead of `localStorage`.
 *
 * `expo-secure-store` has no synchronous read, so unlike web this cannot be known on first
 * render; `CaregiverGate`/`SyncProvider` load it once via an effect and show a brief loading
 * state, a deliberate, documented deviation from web's synchronous read.
 */
const STORAGE_KEY = 'medguard-household-session';

export interface HouseholdSession {
  deviceToken: string;
  householdId: string;
  userId: string;
  deviceId: string;
  householdName?: string;
}

/**
 * In-module pub/sub, replacing web's `window.dispatchEvent`/`addEventListener` (no `window` in
 * React Native) — the same "one dispatch point covers every session change" property web's
 * version documents, so the sync engine can react to a connect/leave/delete without a shared
 * React context.
 */
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export async function getHouseholdSession(): Promise<HouseholdSession | null> {
  const raw = await SecureStore.getItemAsync(STORAGE_KEY);
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

export async function setHouseholdSession(session: HouseholdSession): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(session));
  notify();
}

export async function clearHouseholdSession(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEY);
  notify();
}

/** Subscribes to session changes; returns an unsubscribe function. */
export function onHouseholdSessionChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
