/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';

/**
 * Hand-written service worker (injectManifest strategy).
 *
 * Sprint 0 only precaches the app shell so it opens offline. Sprint 5 adds the `push` and
 * `notificationclick` handlers — including the Shabbat burst, which must render without action
 * buttons while the household is in Shabbat mode (delta D5).
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
