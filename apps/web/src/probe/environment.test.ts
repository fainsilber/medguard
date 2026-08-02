import { describe, expect, it } from 'vitest';
import { checkStoragePersistence, detectPlatform, isInstalledStandalone, snapshotEnvironment } from './environment.js';

function fakeWindow(overrides: {
  userAgent: string;
  standalone?: boolean;
  displayModeStandalone?: boolean;
  serviceWorker?: boolean;
  pushManager?: boolean;
  notification?: NotificationPermission;
}): Window {
  return {
    navigator: {
      userAgent: overrides.userAgent,
      standalone: overrides.standalone,
      ...(overrides.serviceWorker ? { serviceWorker: {} } : {}),
    },
    matchMedia: (query: string) => ({
      matches: query === '(display-mode: standalone)' && (overrides.displayModeStandalone ?? false),
    }),
    ...(overrides.pushManager ? { PushManager: class {} } : {}),
    ...(overrides.notification !== undefined
      ? { Notification: { permission: overrides.notification } }
      : {}),
  } as unknown as Window;
}

describe('detectPlatform', () => {
  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'ios'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'ios'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'android'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'desktop'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'desktop'],
    ['some-unrecognisable-string', 'unknown'],
  ] as const)('classifies %s as %s', (userAgent, expected) => {
    expect(detectPlatform(userAgent)).toBe(expected);
  });
});

describe('isInstalledStandalone', () => {
  it('is true when iOS reports navigator.standalone', () => {
    const win = fakeWindow({ userAgent: 'iPhone', standalone: true });
    expect(isInstalledStandalone(win)).toBe(true);
  });

  it('is true when the display-mode media query matches', () => {
    const win = fakeWindow({ userAgent: 'Android', displayModeStandalone: true });
    expect(isInstalledStandalone(win)).toBe(true);
  });

  it('is false in an ordinary browser tab', () => {
    const win = fakeWindow({ userAgent: 'Android' });
    expect(isInstalledStandalone(win)).toBe(false);
  });
});

describe('snapshotEnvironment', () => {
  it('flags iOS as needing home-screen install when not standalone', () => {
    const win = fakeWindow({ userAgent: 'iPhone' });
    expect(snapshotEnvironment(win).needsHomeScreenInstall).toBe(true);
  });

  it('does not flag an already-installed iOS PWA', () => {
    const win = fakeWindow({ userAgent: 'iPhone', standalone: true });
    expect(snapshotEnvironment(win).needsHomeScreenInstall).toBe(false);
  });

  it('never flags Android, which has no install requirement for push', () => {
    const win = fakeWindow({ userAgent: 'Android' });
    expect(snapshotEnvironment(win).needsHomeScreenInstall).toBe(false);
  });

  it('reports unsupported rather than throwing when Notification does not exist', () => {
    const win = fakeWindow({ userAgent: 'Android' });
    const snapshot = snapshotEnvironment(win);
    expect(snapshot.notificationSupported).toBe(false);
    expect(snapshot.notificationPermission).toBe('unsupported');
  });

  it('reads the real permission value when Notification exists', () => {
    const win = fakeWindow({ userAgent: 'Android', notification: 'granted' });
    const snapshot = snapshotEnvironment(win);
    expect(snapshot.notificationSupported).toBe(true);
    expect(snapshot.notificationPermission).toBe('granted');
  });

  it('detects Service Worker and Push Manager support independently', () => {
    const win = fakeWindow({ userAgent: 'Android', serviceWorker: true, pushManager: true });
    const snapshot = snapshotEnvironment(win);
    expect(snapshot.serviceWorkerSupported).toBe(true);
    expect(snapshot.pushManagerSupported).toBe(true);
  });
});

function fakeStorageManager(overrides: {
  persisted?: boolean;
  persistResult?: boolean;
  quota?: number;
  usage?: number;
}): StorageManager {
  return {
    persisted: async () => overrides.persisted ?? false,
    persist: async () => overrides.persistResult ?? false,
    estimate: async () => ({ quota: overrides.quota, usage: overrides.usage }),
  } as unknown as StorageManager;
}

describe('checkStoragePersistence', () => {
  it('reports the granted result and quota/usage', async () => {
    const result = await checkStoragePersistence(
      fakeStorageManager({ persisted: false, persistResult: true, quota: 1_000_000, usage: 5_000 }),
    );

    expect(result).toEqual({
      persistedBefore: false,
      persistGranted: true,
      quotaBytes: 1_000_000,
      usageBytes: 5_000,
    });
  });

  it('degrades gracefully when the API is entirely unsupported', async () => {
    const result = await checkStoragePersistence({} as StorageManager);

    expect(result).toEqual({
      persistedBefore: false,
      persistGranted: false,
      quotaBytes: null,
      usageBytes: null,
    });
  });
});
