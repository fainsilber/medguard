import { expect, test } from '@playwright/test';

/**
 * Sprint 2's exit gate: the full offline flow — create a medicine, schedule it, log a dose, see
 * stock decrement — passes with no backend running at all. `playwright.config.ts`'s `webServer`
 * only starts the web preview, never `apps/api`, so this is already exercising the app with
 * nothing to talk to.
 *
 * The clock is fixed rather than left real so the schedule's due time reliably falls inside the
 * Today view's "due now" window regardless of when the suite happens to run. The schedule's own
 * time-of-day field is read back from the fixed instant's *local* wall clock (whatever IANA zone
 * the browser resolves to) rather than hardcoded, so this isn't tied to running in any particular
 * timezone.
 */
test('create medicine, schedule it, log a dose offline, and see stock decrement', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-06-15T08:00:00.000Z'));
  await page.goto('/');

  // Caregiver identity gate — the app's entry point.
  await page.getByPlaceholder('e.g. Mom, Dad, Grandma').fill('Mom');
  await page.getByRole('button', { name: 'Continue' }).click();

  const localTimeOfDay = await page.evaluate(() => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  });

  // Create a medicine.
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('button', { name: 'Medicines' }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Name').fill('Ondansetron');
  await page.getByLabel('Strength').fill('4mg');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Ondansetron', { exact: false })).toBeVisible();

  // Start tracking its stock before any dose is logged, so the decrement has a baseline.
  await nav.getByRole('button', { name: 'Inventory' }).click();
  await page.getByRole('button', { name: 'Track stock' }).click();
  await page.getByLabel('Unit').fill('pills');
  await page.getByLabel('Refill at').fill('2');
  await page.getByLabel('Starting count').fill('10');
  await page.getByRole('button', { name: 'Start tracking stock' }).click();
  await expect(page.getByText('10 pills remaining')).toBeVisible();

  // Give it a daily schedule due right now.
  await nav.getByRole('button', { name: 'Medicines' }).click();
  await page.getByRole('button', { name: 'Schedule' }).click();
  await page.getByRole('button', { name: '+ Add schedule' }).click();
  await page.getByLabel('Time 1').fill(localTimeOfDay);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('No active schedule.')).not.toBeVisible();

  // It shows up as due now on the Today view.
  await nav.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByText('Due now')).toBeVisible();
  await expect(page.getByText('Ondansetron 4mg')).toBeVisible();

  // Log it taken — an offline write, straight to IndexedDB, no network involved.
  await page.getByRole('button', { name: 'Taken' }).click();
  await expect(page.getByText('Done')).toBeVisible();
  await expect(page.getByText('Taken by Mom')).toBeVisible();

  // Stock reflects exactly one dose's worth decremented.
  await nav.getByRole('button', { name: 'Inventory' }).click();
  await expect(page.getByText('9 pills remaining')).toBeVisible();
});
