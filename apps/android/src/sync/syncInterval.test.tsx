import {
  DEFAULT_SYNC_INTERVAL_MINUTES,
  SYNC_INTERVAL_OPTIONS,
  getSyncIntervalMinutes,
  onSyncIntervalChange,
  setSyncIntervalMinutes,
} from './syncInterval.js';
import * as SecureStore from 'expo-secure-store';

/**
 * The background-sync interval is a per-device preference stored in `expo-secure-store`. It must
 * degrade to the 15-minute default whenever the stored value can't be trusted — a corrupt entry
 * must never leave a phone with background sync silently off or on a nonsense period.
 */
describe('sync interval preference', () => {
  it('defaults to 15 minutes before anything is chosen', async () => {
    expect(await getSyncIntervalMinutes()).toBe(DEFAULT_SYNC_INTERVAL_MINUTES);
    expect(DEFAULT_SYNC_INTERVAL_MINUTES).toBe(15);
  });

  it('round-trips every preset, including Off', async () => {
    for (const { minutes } of SYNC_INTERVAL_OPTIONS) {
      await setSyncIntervalMinutes(minutes);
      expect(await getSyncIntervalMinutes()).toBe(minutes);
    }
  });

  it('refuses a value that is not a preset', async () => {
    await setSyncIntervalMinutes(60);
    await expect(setSyncIntervalMinutes(5)).rejects.toThrow(RangeError);
    expect(await getSyncIntervalMinutes()).toBe(60);
  });

  it('falls back to the default for a corrupt or no-longer-offered stored value', async () => {
    await SecureStore.setItemAsync('medguard-background-sync-interval', 'banana');
    expect(await getSyncIntervalMinutes()).toBe(15);
    await SecureStore.setItemAsync('medguard-background-sync-interval', '7');
    expect(await getSyncIntervalMinutes()).toBe(15);
  });

  it('notifies listeners on change until they unsubscribe', async () => {
    const listener = jest.fn();
    const unsubscribe = onSyncIntervalChange(listener);

    await setSyncIntervalMinutes(1440);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    await setSyncIntervalMinutes(15);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
