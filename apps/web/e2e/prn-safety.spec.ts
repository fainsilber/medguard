import { expect, test } from '@playwright/test';
import { pinPerformanceClockToWallClock } from './support/clockTrust.js';

/**
 * The highest-consequence flow with no browser-level test before this: an as-needed dose that's
 * inside its own cooldown window still has to reach an `IntakeLog`, but only through two separate,
 * deliberate confirmations (`PrnCard.tsx`) — a reason and then an explicit "yes, really" a moment
 * later. Unit tests already prove each state renders correctly; what they can't prove is that the
 * two confirmations actually gate the write in a real browser, with real clicks landing on real
 * buttons that swap in and out as the phase changes.
 *
 * See support/clockTrust.ts for why `pinPerformanceClockToWallClock` runs before every `goto` here:
 * this suite is testing the override confirmation flow, not `getLocalClockTrust()`'s own drift
 * detection, so a CI-runner scheduling hiccup flipping the card to "Clock unverified" mid-test
 * would be a false failure, not a real one.
 */
test('a cooldown-blocked PRN dose needs two separate confirmations before it writes anything', async ({
  page,
}) => {
  await pinPerformanceClockToWallClock(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Use this device on its own for now' }).click();
  await page.getByPlaceholder('e.g. Mom, Dad, Grandma').fill('Mom');
  await page.getByRole('button', { name: 'Continue' }).click();

  const nav = page.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('button', { name: 'Medicines' }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Name').fill('Ibuprofen');
  await page.getByLabel('Strength').fill('200mg');
  await page.getByLabel(/As needed/).check();
  await page.getByLabel('Min hours between doses').fill('4');
  await page.getByRole('button', { name: 'Save' }).click();

  await nav.getByRole('button', { name: 'As needed' }).click();
  await expect(page.getByText('🟢 Safe to take')).toBeVisible();

  // First dose: unblocked, one click, no override machinery involved.
  await page.getByRole('button', { name: 'Give dose' }).click();
  await expect(page.getByText(/Last given by Mom at \d\d:\d\d \(1\)/)).toBeVisible();

  // The 4-hour cooldown is now in effect — the safe path is gone, replaced by the override door.
  await expect(page.getByText('🔴 Locked')).toBeVisible();
  await expect(page.getByText(/Locked: .* remaining/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Give dose' })).not.toBeVisible();

  const overrideButton = page.getByRole('button', { name: 'Give anyway (override)' });
  await expect(overrideButton).toBeVisible();

  // Step 1 of 2: a reason is required, and Continue stays disabled without one.
  await overrideButton.click();
  const continueButton = page.getByRole('button', { name: 'Continue' });
  await expect(continueButton).toBeDisabled();
  await page.getByLabel('Why are you overriding this?').fill('Breakthrough pain, caregiver judgment call');
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  // Step 2 of 2: an explicit "yes, really" — nothing has been written yet.
  await expect(page.getByRole('alert')).toContainText('This will be permanently recorded as an override');

  await page.getByRole('button', { name: 'Yes, give the dose' }).click();

  // Now it's written, and the override panel is gone.
  await expect(page.getByRole('button', { name: 'Yes, give the dose' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Give anyway (override)' })).toBeVisible();

  // Two rows now, not one — `quantityTaken` is always 1 for a single PRN dose (`give()` hardcodes
  // it), so this Log count, not the PrnCard's own "(1)" display, is what actually distinguishes
  // "one dose given" from "two". The second row carries the reason into the permanent record.
  await nav.getByRole('button', { name: 'Log' }).click();
  await expect(page.locator('table tbody tr')).toHaveCount(2);
  await expect(
    page.getByText('Override (cooldown): Breakthrough pain, caregiver judgment call'),
  ).toBeVisible();
});

test('cancelling either override step writes nothing', async ({ page }) => {
  await pinPerformanceClockToWallClock(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Use this device on its own for now' }).click();
  await page.getByPlaceholder('e.g. Mom, Dad, Grandma').fill('Dad');
  await page.getByRole('button', { name: 'Continue' }).click();

  const nav = page.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('button', { name: 'Medicines' }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Name').fill('Ibuprofen');
  await page.getByLabel('Strength').fill('200mg');
  await page.getByLabel(/As needed/).check();
  await page.getByLabel('Min hours between doses').fill('4');
  await page.getByRole('button', { name: 'Save' }).click();

  await nav.getByRole('button', { name: 'As needed' }).click();
  await page.getByRole('button', { name: 'Give dose' }).click();
  await expect(page.getByText(/Last given by Dad at \d\d:\d\d \(1\)/)).toBeVisible();

  // Cancel at the reason step.
  await page.getByRole('button', { name: 'Give anyway (override)' }).click();
  await page.getByLabel('Why are you overriding this?').fill('changed my mind');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Give anyway (override)' })).toBeVisible();

  // Cancel again at the confirm step — still nothing written.
  await page.getByRole('button', { name: 'Give anyway (override)' }).click();
  await page.getByLabel('Why are you overriding this?').fill('Breakthrough pain');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText('This will be permanently recorded as an override');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByRole('button', { name: 'Give anyway (override)' })).toBeVisible();

  // The Log view is the real proof: still exactly the one dose from before either cancelled
  // override attempt, not two.
  await nav.getByRole('button', { name: 'Log' }).click();
  await expect(page.locator('table tbody tr')).toHaveCount(1);
});
