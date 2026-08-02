/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import type { ProbePushPayload, ProbePushReceipt } from '@medguard/shared';
import { buildNotificationOptions, retainedOptions } from './probe/notificationOptions.js';
import type { ExtendedNotification } from './probe/notificationOptions.js';
import { saveReceipt } from './probe/receiptStore.js';

/**
 * Hand-written service worker (injectManifest strategy).
 *
 * The browser transparently decrypts the RFC 8291 aes128gcm payload before this handler ever
 * sees it — `event.data.json()` already returns our original plaintext. That's why getting the
 * server-side encryption scheme right (see apps/api/src/push/encrypt.ts) matters: a browser
 * that can't decrypt the payload never fires `push` at all, and there is no error to observe.
 *
 * Sprint 5 replaces this handler with the real dose/escalation logic and "Taken"/"Snooze"
 * actions. For now it only understands the Sprint 0 capability probe. Kept intentionally thin —
 * the testable logic lives in ./probe/notificationOptions.ts, since this file references `self`
 * at import time and can't safely be imported under a test runner.
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

async function handleProbePush(payload: ProbePushPayload): Promise<void> {
  const receivedAtIso = new Date().toISOString();

  await self.registration.showNotification(payload.title, buildNotificationOptions(payload));

  // renotify + a shared tag replaces rather than stacks, so there should be exactly one match.
  const shown = payload.tag
    ? await self.registration.getNotifications({ tag: payload.tag })
    : await self.registration.getNotifications();

  const receipt: ProbePushReceipt = {
    kind: 'probe-push-receipt',
    sentAtIso: payload.sentAtIso,
    receivedAtIso,
    burstIndex: payload.burstIndex,
    burstTotal: payload.burstTotal,
    retainedOptions: retainedOptions(payload, shown.at(-1) as ExtendedNotification | undefined),
  };

  await saveReceipt(receipt);

  // Best-effort live update if the page happens to be open. The receipt above is what makes
  // the result durable when it isn't — which is the normal case, since the whole point is
  // testing delivery to a locked, backgrounded device.
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) client.postMessage(receipt);
}

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload: ProbePushPayload;
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  if (payload.kind !== 'probe') return;

  event.waitUntil(handleProbePush(payload));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients[0];
      return existing ? existing.focus() : self.clients.openWindow('/');
    }),
  );
});
