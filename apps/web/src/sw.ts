/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { SNOOZE_ACTION, TAKEN_ACTION, parsePushPayload, prepareNotification } from './push/notification.js';
import type { NotificationData } from './push/notification.js';
import { recordPendingAction } from './push/pendingActionStore.js';

/**
 * Hand-written service worker (injectManifest strategy).
 *
 * The browser transparently decrypts the RFC 8291 aes128gcm payload before this handler ever
 * sees it — `event.data.json()` already returns our original plaintext. That's why getting the
 * server-side encryption scheme right (see apps/api/src/push/encrypt.ts) matters: a browser
 * that can't decrypt the payload never fires `push` at all, and there is no error to observe.
 *
 * Kept deliberately thin. Everything with a decision in it lives in `./push/`, because this file
 * references `self` at import time and cannot be imported under a test runner — and the rules
 * about which notification carries action buttons, and what a tapped button means, are exactly
 * the rules that need tests.
 *
 * **This worker never writes the medical record.** A tapped action is recorded as *intent* to a
 * separate IndexedDB store and converted into an `IntakeLog` by the app, through the same
 * repository transaction the UI uses. That is delta AD2 — written for Kotlin, and true here for
 * the same reason: a second implementation of the append-only ledger, in a context with no
 * clock injection and no safety checks, is how a dose ends up recorded wrongly or twice.
 */
declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let raw: unknown;
  try {
    raw = event.data.json();
  } catch {
    return;
  }

  const payload = parsePushPayload(raw);
  if (!payload) return;

  const { title, options } = prepareNotification(payload);
  event.waitUntil(self.registration.showNotification(title, options));
});

/** Focuses an open tab if there is one, and opens the app if there isn't. */
async function openApp(): Promise<void> {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = clients[0];
  if (existing) {
    await existing.focus();
    return;
  }
  await self.clients.openWindow('/');
}

/**
 * Captures a tapped action and gets the app in front of the caregiver.
 *
 * The order matters: the intent is written first and awaited, so a tap survives the browser
 * declining to open a window, the page being slow, or the worker being killed a moment later.
 * The app drains it on its next start (see `PushProvider`), and the recorded timestamp is the
 * tap instant rather than the drain instant — `actualTime` starts the rolling-24h cap window, so
 * recording the wrong moment misstates both the history and the safety arithmetic.
 */
async function captureAction(data: NotificationData, action: string): Promise<void> {
  if (data.occurrenceId) {
    await recordPendingAction({
      id: crypto.randomUUID(),
      occurrenceKey: data.occurrenceId,
      action: action === SNOOZE_ACTION ? 'snooze' : 'taken',
      tappedAtMs: Date.now(),
    });
  }

  // A snooze is a deliberate "not now" — dragging the app to the foreground would be the opposite
  // of what the caregiver just asked for.
  if (action !== SNOOZE_ACTION) {
    await openApp();
  }

  // Nudge any live page to drain immediately rather than waiting for its next mount.
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    client.postMessage({ kind: 'medguard:pending-action' });
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data as NotificationData | undefined;
  const action = event.action;

  if (data && (action === TAKEN_ACTION || action === SNOOZE_ACTION)) {
    event.waitUntil(captureAction(data, action));
    return;
  }

  // The body of the notification rather than an action button: just show the caregiver the app.
  // On Shabbat this is the only thing a tap can do, by design (delta D5).
  event.waitUntil(openApp());
});
