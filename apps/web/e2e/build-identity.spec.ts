import { expect, test } from '@playwright/test';

/**
 * CLAUDE.md's "every app must expose its build identity" rule has no automated enforcement
 * anywhere in the repo today — it's checked by eye, if at all. This doesn't verify the git SHA or
 * timestamp are *correct* (that's `vite.config.ts`'s `gitShortSha()` and `version.ts`'s own
 * fallback tests), only that the Diagnostics page actually renders them in the built app, which is
 * the one thing a unit test importing `version.ts` directly can't prove.
 */
test('the Diagnostics page shows a build version and timestamp', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: 'Use this device on its own for now' }).click();
  await page.getByPlaceholder('e.g. Mom, Dad, Grandma').fill('Mom');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Diagnostics' }).click();

  // `version.ts` falls back to 'dev' rather than failing the build when Vite has no
  // `__APP_VERSION__` define (e.g. `vite dev`), so this only pins the "v{...}" shape — a real git
  // SHA under this suite's production build, but not something worth hardcoding and re-breaking
  // on every commit.
  await expect(page.getByText(/^v\S+/)).toBeVisible();
});
