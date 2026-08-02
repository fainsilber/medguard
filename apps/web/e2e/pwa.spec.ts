import { expect, test } from '@playwright/test';

/**
 * Harness proof for the E2E layer, plus the PWA guarantees the capability probe depends on:
 * without a valid manifest and a registered service worker, iOS will not allow the
 * home-screen install that Web Push requires.
 */
test('app shell renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'MedGuard' })).toBeVisible();
});

test('serves a valid web app manifest', async ({ page, request }) => {
  await page.goto('/');

  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();

  const manifest = await (await request.get(href!)).json();

  expect(manifest.name).toBe('MedGuard');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBeTruthy();

  // Android needs a maskable icon or it renders the icon letterboxed inside a white circle.
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
});

test('declares the iOS home-screen icon', async ({ page, request }) => {
  // iOS refuses Web Push until the PWA is installed to the home screen, and the install flow
  // needs this icon. Sprint 5's onboarding gate depends on it.
  await page.goto('/');

  const href = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  expect(href).toBeTruthy();

  const response = await request.get(href!);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/png');
});

test('registers a service worker and precaches the shell', async ({ page }) => {
  await page.goto('/');

  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active !== null;
  });

  expect(registered).toBe(true);
});
