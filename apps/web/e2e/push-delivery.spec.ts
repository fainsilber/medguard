import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import { PUSH_PAYLOAD_VERSION } from '@medguard/shared';

/**
 * Closes the doc-vs-reality gap at docs/medguard-sprint-plan.md: a "Push | Playwright + CDP
 * deliverPushMessage" row has named this layer for a while, but `grep -rn deliverPushMessage`
 * found only the doc mentions — it was never built. `sw.ts`'s `push` handler is excluded from the
 * coverage gate on the stated grounds that "correctness is proven by the E2E suite"; before this
 * file, nothing did.
 *
 * `page.route()` can't help here — a push event is delivered by the browser's own push service,
 * not fetched by the page, so there's nothing for it to intercept. `ServiceWorker.deliverPushMessage`
 * is Chrome DevTools Protocol's way of injecting one directly into an already-registered worker,
 * which is exactly the boundary this needs to cross: real `sw.ts`, built by the real production
 * bundle this suite already runs against, receiving a real `push` event and calling the real
 * `self.registration.showNotification()` — not a mocked handler.
 */

async function deliverPush(
  client: CDPSession,
  baseURL: string,
  payload: unknown,
): Promise<void> {
  await client.send('ServiceWorker.enable');

  const registrationId = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Timed out waiting for a ServiceWorker registration for this origin.')),
      15_000,
    );
    client.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const match = registrations.find((registration) => registration.scopeURL.startsWith(baseURL));
      if (match) {
        clearTimeout(timeout);
        resolve(match.registrationId);
      }
    });
  });

  await client.send('ServiceWorker.deliverPushMessage', {
    origin: baseURL,
    registrationId,
    data: JSON.stringify(payload),
  });
}

/**
 * `Notification`'s `title`/`body`/`tag`/`actions` are getters on `Notification.prototype`, not own
 * properties on the instance — `page.evaluate`'s structured-clone-style return serialization drops
 * them, so a bare `registration.getNotifications()` comes back across the CDP boundary as `[{}]`.
 * Reading each field out explicitly, inside the page, is what actually gets their values home.
 */
async function shownNotifications(
  page: Page,
): Promise<{ title: string; body: string; tag: string; actions: { action: string; title: string }[] }[]> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const notifications = await registration.getNotifications();
    return notifications.map((notification) => ({
      title: notification.title,
      body: notification.body,
      tag: notification.tag,
      actions: notification.actions.map((action) => ({ action: action.action, title: action.title })),
    }));
  });
}

test('a dose push renders a notification with Taken/Snooze actions, through the real service worker', async ({
  page,
  baseURL,
}) => {
  await page.context().grantPermissions(['notifications']);
  await page.goto('/');
  // `precacheAndRoute`'s manifest fetch and `skipWaiting()` both need a moment after first paint;
  // `navigator.serviceWorker.ready` is the real signal the worker is installed and controlling.
  await page.evaluate(() => navigator.serviceWorker.ready);

  const client = await page.context().newCDPSession(page);
  await deliverPush(client, baseURL!, {
    v: PUSH_PAYLOAD_VERSION,
    kind: 'dose',
    sentAtIso: '2026-06-15T08:00:00.000Z',
    occurrenceId: 'sched-1:2026-06-15T08:00:00.000Z',
    medicineId: 'med-1',
    medicineName: 'Ondansetron',
    scheduleId: 'sched-1',
    dueAtIso: '2026-06-15T08:00:00.000Z',
    dosageQuantity: 1,
  });

  await expect(async () => {
    const notifications = await shownNotifications(page);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: 'Ondansetron — dose due',
      body: '1 due now',
      tag: 'sched-1:2026-06-15T08:00:00.000Z',
    });
    expect(notifications[0]!.actions.map((action) => action.action)).toEqual(['taken', 'snooze']);
  }).toPass();
});

test('a Shabbat push renders with no action buttons — a tap must never write a record (delta D5)', async ({
  page,
  baseURL,
}) => {
  await page.context().grantPermissions(['notifications']);
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);

  const client = await page.context().newCDPSession(page);
  await deliverPush(client, baseURL!, {
    v: PUSH_PAYLOAD_VERSION,
    kind: 'shabbat',
    sentAtIso: '2026-06-19T18:00:00.000Z',
    occurrenceId: 'sched-2:2026-06-19T18:00:00.000Z',
    medicineId: 'med-2',
    medicineName: 'Metformin',
    scheduleId: 'sched-2',
    dueAtIso: '2026-06-19T18:00:00.000Z',
    dosageQuantity: 1,
    burstIndex: 1,
    burstTotal: 10,
  });

  await expect(async () => {
    const notifications = await shownNotifications(page);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: 'Metformin — dose due',
      body: '1 due now. No action needed on the phone.',
    });
    expect(notifications[0]!.actions).toHaveLength(0);
  }).toPass();
});

test('an unrecognised payload version is ignored rather than half-rendered', async ({ page, baseURL }) => {
  await page.context().grantPermissions(['notifications']);
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);

  const client = await page.context().newCDPSession(page);
  await deliverPush(client, baseURL!, {
    v: 999,
    kind: 'dose',
    sentAtIso: '2026-06-15T08:00:00.000Z',
    occurrenceId: 'sched-3:2026-06-15T08:00:00.000Z',
    medicineId: 'med-3',
    medicineName: 'Should not render',
    scheduleId: 'sched-3',
    dueAtIso: '2026-06-15T08:00:00.000Z',
    dosageQuantity: 1,
  });

  // No `.toPass()` retry here on purpose — this asserts an absence, and a retry loop around an
  // absence just waits out its own timeout instead of proving anything sooner.
  await page.waitForTimeout(1_000);
  expect(await shownNotifications(page)).toHaveLength(0);
});
