import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Sprint 4's exit gate, live: real-time propagation and offline replay through the real API and
 * Durable Object — not stubbed. Every other e2e spec in this suite stubs `apps/api` via
 * `page.route()`, which is fine because the routes involved are already proven at the integration
 * level in `apps/api/tests/`; a WebSocket connection can't be intercepted that way, though, so
 * proving real-time delivery needs a real `wrangler dev` running alongside the web preview — see
 * the second `webServer` entry in playwright.config.ts.
 */

async function createHousehold(page: Page, householdName: string, displayName: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start a new household' }).click();
  await page.getByLabel('Household name').fill(householdName);
  await page.getByLabel('Your name').fill(displayName);
  await page.getByRole('button', { name: 'Create household' }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
}

async function inviteCode(page: Page): Promise<string> {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Household' }).click();
  await page.getByRole('button', { name: 'Invite another caregiver' }).click();
  const code = await page.getByText(/^\d{6}$/).textContent();
  if (!code) {
    throw new Error('No join code appeared');
  }
  return code;
}

async function joinHousehold(page: Page, code: string, displayName: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Join with a code' }).click();
  await page.getByLabel('Join code').fill(code);
  await page.getByLabel('Your name').fill(displayName);
  await page.getByRole('button', { name: 'Join household' }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
}

async function addAsNeededMedicine(page: Page, name: string, strength: string) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Medicines' }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Strength').fill(strength);
  await page.getByRole('radio', { name: /As needed/ }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(name, { exact: false })).toBeVisible();
}

test('a dose logged on one device reaches the other within the 1.5s broadcast budget', async ({ browser }) => {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();

  await createHousehold(pageA, 'The Cohens', 'Mom');
  await addAsNeededMedicine(pageA, 'Ondansetron', '4mg');
  const code = await inviteCode(pageA);
  await joinHousehold(pageB, code, 'Dad');

  // B has to have received the medicine itself before timing the dose broadcast specifically.
  await pageB.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'As needed' }).click();
  await expect(pageB.getByText('Ondansetron', { exact: false })).toBeVisible({ timeout: 10_000 });

  await pageA.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'As needed' }).click();
  await expect(pageA.getByRole('button', { name: 'Give dose' })).toBeVisible();

  const startedAt = Date.now();
  await pageA.getByRole('button', { name: 'Give dose' }).click();

  await expect(pageB.getByText(/Last given by Mom/)).toBeVisible({ timeout: 5_000 });
  const elapsedMs = Date.now() - startedAt;

  expect(elapsedMs).toBeLessThan(1500);

  await contextA.close();
  await contextB.close();
});

test('a dose logged while offline replays once back online, with zero log loss', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await createHousehold(page, 'The Bakers', 'Mom');
  await addAsNeededMedicine(page, 'Paracetamol', '250mg');

  await context.setOffline(true);

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'As needed' }).click();
  await page.getByRole('button', { name: 'Give dose' }).click();
  // The write itself is local-only and offline-safe — this must succeed with no network at all.
  await expect(page.getByText(/Last given by Mom/)).toBeVisible();

  await context.setOffline(false);
  // Proves `SyncProvider`'s `window.addEventListener('online', …)` handler, not just the
  // WebSocket's own reconnect: Chromium's `context.setOffline()` against a loopback connection
  // blocks HTTP fetches (confirmed here via `ERR_INTERNET_DISCONNECTED`) but does not reliably
  // close an already-open WebSocket, so `LiveClient` never observes a drop-and-reconnect and
  // its 'open' transition — the only other trigger for a retry — never fires. Without the
  // explicit `online` listener this hangs forever, not just slowly: confirmed by instrumenting
  // a real run, which sat at "Sync error" for 45s with no further activity at all until the
  // listener was added, after which "Synced" appeared within ~300ms of going back online.
  await expect(page.getByText('Synced')).toBeVisible({ timeout: 15_000 });

  // Proof the dose actually reached the server, not just that the local UI stopped complaining: a
  // second device joining fresh afterwards has to see it too.
  const code = await inviteCode(page);

  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  await joinHousehold(otherPage, code, 'Dad');

  await otherPage.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'As needed' }).click();
  await expect(otherPage.getByText(/Last given by Mom/)).toBeVisible({ timeout: 10_000 });

  await context.close();
  await otherContext.close();
});
