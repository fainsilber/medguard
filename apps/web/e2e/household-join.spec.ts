import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Sprint 3's exit gate, in the browser: a second device joins a household with a 6-digit code and
 * sees what the first device created.
 *
 * Runs against a stubbed API rather than a live one. Every route involved is already tested against
 * the real workerd runtime and real D1 in `apps/api/tests/`; what has *no* coverage without this is
 * the browser half — that the onboarding screens read the code, store the returned token, and put
 * the device into a connected state. Booting a second server here would re-test the backend and
 * make the suite depend on port availability, without covering anything more.
 */

const HOUSEHOLD_ID = 'household-1';

/** Stands in for the API, tracking whether a code has already been redeemed. */
async function stubApi(page: Page) {
  let issuedCode: string | null = null;
  let redeemed = false;

  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.includes('/api/v1/time')) {
      return json({ nowIso: new Date().toISOString(), nowMs: Date.now() });
    }

    if (url.includes('/api/v1/households')) {
      return json(
        { deviceToken: 'token-a', householdId: HOUSEHOLD_ID, userId: 'user-a', deviceId: 'device-a' },
        201,
      );
    }

    if (url.includes('/api/v1/join-codes/redeem')) {
      const body = route.request().postDataJSON() as { code: string };
      if (redeemed || body.code !== issuedCode) {
        return json({ error: 'invalid_code' }, 400);
      }
      redeemed = true;
      return json(
        { deviceToken: 'token-b', householdId: HOUSEHOLD_ID, userId: 'user-b', deviceId: 'device-b' },
        201,
      );
    }

    if (url.includes('/api/v1/join-codes')) {
      issuedCode = '482913';
      return json({ code: issuedCode, expiresAt: 'later', expiresInSeconds: 900 }, 201);
    }

    return json({ error: 'not_found' }, 404);
  });
}

test('a caregiver creates a household and invites a second device with a code', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Start a new household' }).click();
  await page.getByLabel('Household name').fill('The Cohens');
  await page.getByLabel('Your name').fill('Mom');
  await page.getByRole('button', { name: 'Create household' }).click();

  // The app unlocks straight into the shell — no separate name prompt, because onboarding captured it.
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Household' }).click();
  await expect(page.getByText(/Connected to The Cohens/)).toBeVisible();

  await page.getByRole('button', { name: 'Invite another caregiver' }).click();
  await expect(page.getByText('482913')).toBeVisible();
  await expect(page.getByText(/works once/)).toBeVisible();
});

test('a second device joins with the code and lands in the same household', async ({ browser }) => {
  // A separate context is a genuinely separate device: its own localStorage and its own IndexedDB.
  const context = await browser.newContext();
  const page = await context.newPage();
  await stubApi(page);

  // Issue a code first, the way the inviting device would have — the stub only accepts a code it
  // has actually handed out.
  await page.goto('/');
  await page.evaluate(async () => {
    await fetch('/api/v1/join-codes', { method: 'POST' });
  });

  await page.getByRole('button', { name: 'Join with a code' }).click();
  await page.getByLabel('Join code').fill('482913');
  await page.getByLabel('Your name').fill('Dad');
  await page.getByRole('button', { name: 'Join household' }).click();

  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Household' }).click();
  await expect(page.getByText(/Doses logged here are shared/)).toBeVisible();

  await context.close();
});

test('a wrong code is refused with an explanation, not a silent failure', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Join with a code' }).click();
  await page.getByLabel('Join code').fill('000000');
  await page.getByLabel('Your name').fill('Dad');
  await page.getByRole('button', { name: 'Join household' }).click();

  await expect(page.getByRole('alert')).toContainText(/expired or already been used/);
  await expect(page.getByRole('navigation', { name: 'Sections' })).not.toBeVisible();
});
