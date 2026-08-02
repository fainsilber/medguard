/**
 * Platform capability checks for the Sprint 0 probe: install state, API support, and storage
 * persistence. Each answers one of the questions the sprint plan lists as needing evidence from
 * a real device rather than the spec.
 */

export type Platform = 'ios' | 'android' | 'desktop' | 'unknown';

export function detectPlatform(userAgent: string): Platform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return 'ios';
  if (/Android/i.test(userAgent)) return 'android';
  if (/Macintosh|Windows|Linux/i.test(userAgent)) return 'desktop';
  return 'unknown';
}

/** iOS Safari reports itself as standalone via `navigator.standalone`; other browsers via the display-mode media query. */
export function isInstalledStandalone(win: Window): boolean {
  const iosStandalone = (win.navigator as Navigator & { standalone?: boolean }).standalone;
  return iosStandalone === true || win.matchMedia?.('(display-mode: standalone)').matches === true;
}

export interface EnvironmentSnapshot {
  platform: Platform;
  installedStandalone: boolean;
  /** iOS refuses Web Push until the PWA is installed to the home screen (16.4+). */
  needsHomeScreenInstall: boolean;
  serviceWorkerSupported: boolean;
  pushManagerSupported: boolean;
  notificationSupported: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
}

export function snapshotEnvironment(win: Window): EnvironmentSnapshot {
  const platform = detectPlatform(win.navigator.userAgent);
  const installedStandalone = isInstalledStandalone(win);

  // `Window` isn't typed with a `Notification` property in TS's ambient libs (it's added by
  // whichever global scope is active at runtime, not declared statically), so read it via the
  // same reflection pattern used for the equally-untyped Notification fields in sw.ts.
  const notificationCtor = (win as unknown as { Notification?: typeof Notification }).Notification;

  return {
    platform,
    installedStandalone,
    needsHomeScreenInstall: platform === 'ios' && !installedStandalone,
    serviceWorkerSupported: 'serviceWorker' in win.navigator,
    pushManagerSupported: 'PushManager' in win,
    notificationSupported: notificationCtor !== undefined,
    notificationPermission: notificationCtor ? notificationCtor.permission : 'unsupported',
  };
}

export interface StorageCheckResult {
  persistedBefore: boolean;
  persistGranted: boolean;
  quotaBytes: number | null;
  usageBytes: number | null;
}

/**
 * `navigator.storage.persist()` asks the browser not to evict IndexedDB under storage
 * pressure. Whether it's actually granted is decided by the browser (frequently tied to
 * whether the site is installed/bookmarked), which is exactly why this needs to run for real
 * rather than be assumed.
 */
export async function checkStoragePersistence(storage: StorageManager): Promise<StorageCheckResult> {
  const persistedBefore = (await storage.persisted?.()) ?? false;
  const persistGranted = (await storage.persist?.()) ?? false;
  const estimate = await storage.estimate?.();

  return {
    persistedBefore,
    persistGranted,
    quotaBytes: estimate?.quota ?? null,
    usageBytes: estimate?.usage ?? null,
  };
}
