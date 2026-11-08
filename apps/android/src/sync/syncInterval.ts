import * as SecureStore from 'expo-secure-store';

/**
 * How often the app syncs in the background while it is closed — a per-device preference, not a
 * household setting: it trades battery and data on *this* phone, and is not medical data, so it is
 * kept locally (like the API URL override in `api/config.ts`) and never synced.
 *
 * Presets rather than a free number: Android's WorkManager cannot go below 15 minutes, and a fixed
 * list leaves no invalid value to validate. `0` means off — background sync is not scheduled at
 * all, while foreground sync, retries and tap-to-sync are unaffected.
 */
const STORAGE_KEY = 'medguard-background-sync-interval';

export interface SyncIntervalOption {
  /** Minutes between background syncs; `0` = off. */
  minutes: number;
  label: string;
}

export const SYNC_INTERVAL_OPTIONS: readonly SyncIntervalOption[] = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 360, label: '6 hours' },
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: 'Once a day' },
  { minutes: 0, label: 'Off' },
];

/** Matches what shipped before this was configurable, so existing installs behave as before. */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 15;

function isValid(minutes: number): boolean {
  return SYNC_INTERVAL_OPTIONS.some((option) => option.minutes === minutes);
}

const listeners = new Set<() => void>();

/** Fires after the stored interval changes, so a connected `SyncProvider` can reschedule at once. */
export function onSyncIntervalChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A missing, corrupt or no-longer-offered stored value falls back to the default. */
export async function getSyncIntervalMinutes(): Promise<number> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (raw === null) {
      return DEFAULT_SYNC_INTERVAL_MINUTES;
    }
    const parsed = Number(raw);
    return isValid(parsed) ? parsed : DEFAULT_SYNC_INTERVAL_MINUTES;
  } catch {
    return DEFAULT_SYNC_INTERVAL_MINUTES;
  }
}

export async function setSyncIntervalMinutes(minutes: number): Promise<void> {
  if (!isValid(minutes)) {
    throw new RangeError(`Unsupported background sync interval: ${minutes}`);
  }
  await SecureStore.setItemAsync(STORAGE_KEY, String(minutes));
  for (const listener of listeners) {
    listener();
  }
}
