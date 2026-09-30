import { expect, test } from '@playwright/test';

/**
 * The privacy policy is a static file, not a route of the app, so it has to survive being served
 * next to a service worker that precaches and intercepts navigations. Google Play requires it to
 * load without a login, so nothing here signs in or sets any state.
 */
test('serves the policy as a plain page, with no app shell around it', async ({ page }) => {
  const response = await page.goto('/privacy.html');

  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole('heading', { level: 1, name: 'MedGuard Privacy Policy' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: /Keeping and deleting information/ }),
  ).toBeVisible();
  // The React app is not mounted on this page.
  await expect(page.locator('#root')).toHaveCount(0);
});

test('is reachable from the first screen a new caregiver sees, in a new tab', async ({ page }) => {
  await page.goto('/');

  const [policy] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('link', { name: 'Privacy policy' }).click(),
  ]);

  await policy.waitForLoadState();
  await expect(policy).toHaveURL(/\/privacy\.html$/);
  await expect(
    policy.getByRole('heading', { level: 1, name: 'MedGuard Privacy Policy' }),
  ).toBeVisible();
});

test('is still readable offline once the service worker has cached it', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  // The precache is filled during install; give the page one reload under the worker's control
  // so the next navigation is served by it rather than the network.
  await page.reload();

  await context.setOffline(true);
  const response = await page.goto('/privacy.html');

  expect(response?.ok()).toBe(true);
  await expect(
    page.getByRole('heading', { level: 1, name: 'MedGuard Privacy Policy' }),
  ).toBeVisible();
});
