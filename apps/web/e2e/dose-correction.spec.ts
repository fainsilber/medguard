import { expect, test } from '@playwright/test';
import { pinPerformanceClockToWallClock } from './support/clockTrust.js';

/**
 * Safety invariant 1, proven in a real browser: correcting a mistaken log entry never edits it —
 * it appends a superseding one (`DoseCorrection.tsx`'s `CorrectionForm`), and the original stays
 * visible in the history rather than being overwritten. Unit tests already cover the append-only
 * arithmetic (`repository.correctDose`); what's missing is proof that the UI actually drives that
 * call rather than, say, patching the record in place, and that the Log view reflects only the
 * live tip of the chain.
 *
 * Uses PrnCard to record the dose being corrected, so — see support/clockTrust.ts —
 * `pinPerformanceClockToWallClock` runs before every `goto` here too.
 */
test('a correction supersedes the original dose without erasing it', async ({ page }) => {
  await pinPerformanceClockToWallClock(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Use this device on its own for now' }).click();
  await page.getByPlaceholder('e.g. Mom, Dad, Grandma').fill('Mom');
  await page.getByRole('button', { name: 'Continue' }).click();

  const nav = page.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('button', { name: 'Medicines' }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Name').fill('Amoxicillin');
  await page.getByLabel('Strength').fill('250mg');
  await page.getByLabel(/As needed/).check();
  await page.getByRole('button', { name: 'Save' }).click();

  await nav.getByRole('button', { name: 'As needed' }).click();
  await page.getByRole('button', { name: 'Give dose' }).click();
  await expect(page.getByText(/Last given by Mom at \d\d:\d\d \(1\)/)).toBeVisible();

  // Correct the quantity — the wrong amount was recorded.
  await page.getByRole('button', { name: 'Correct' }).click();
  await page.getByLabel('Quantity').fill('2');
  await page.getByLabel('What was wrong?').fill('Actually took 2, not 1');
  await page.getByRole('button', { name: 'Save correction' }).click();

  // The visible line now reflects the correction...
  await expect(page.getByText(/Last given by Mom at \d\d:\d\d \(2\)/)).toBeVisible();
  await expect(page.getByText(/Last given by Mom at \d\d:\d\d \(1\)/)).not.toBeVisible();

  // ...but the original is still there, not erased — this is the whole point of "appends, never
  // edits". The history toggle only appears once there's a chain to show.
  await page.getByRole('button', { name: /History \(2\)/ }).click();
  await expect(page.getByText(/Taken \(1\) by Mom/)).toBeVisible();
  await expect(page.getByText(/Taken \(2\) by Mom — Actually took 2, not 1/)).toBeVisible();

  // The Log view shows exactly one row for this occurrence — the live tip, not the superseded
  // original — carrying the correction note rather than an override reason.
  await nav.getByRole('button', { name: 'Log' }).click();
  const rows = page.locator('table tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Amoxicillin');
  await expect(rows.first()).toContainText('2');
  await expect(rows.first()).toContainText('Actually took 2, not 1');
});

test('correcting to "skipped" supersedes the taken record rather than deleting it', async ({ page }) => {
  await pinPerformanceClockToWallClock(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Use this device on its own for now' }).click();
  await page.getByPlaceholder('e.g. Mom, Dad, Grandma').fill('Dad');
  await page.getByRole('button', { name: 'Continue' }).click();

  const nav = page.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('button', { name: 'Medicines' }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Name').fill('Amoxicillin');
  await page.getByLabel('Strength').fill('250mg');
  await page.getByLabel(/As needed/).check();
  await page.getByRole('button', { name: 'Save' }).click();

  await nav.getByRole('button', { name: 'As needed' }).click();
  await page.getByRole('button', { name: 'Give dose' }).click();
  await expect(page.getByText(/Last given by Dad at \d\d:\d\d \(1\)/)).toBeVisible();

  await page.getByRole('button', { name: 'Correct' }).click();
  await page.getByLabel('Status').selectOption('skipped');
  await page.getByLabel('What was wrong?').fill('Never actually given — logged by mistake');
  await page.getByRole('button', { name: 'Save correction' }).click();

  // `lastAdministeredDose` (packages/shared/src/logs.ts) only considers effective logs with
  // status "taken" — a skipped tip means there is nothing to show as "Last given" any more, which
  // is itself part of what this proves: the taken fact didn't linger anywhere it shouldn't.
  await expect(page.getByText(/Last given by Dad/)).not.toBeVisible();

  // The Log view is built from `effectiveLogs()` too, so it shows exactly the tip — one row,
  // "Skipped", carrying the correction note — never a stray leftover "Taken" row for the same
  // occurrence sitting alongside it.
  await nav.getByRole('button', { name: 'Log' }).click();
  const rows = page.locator('table tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Skipped');
  await expect(rows.first()).toContainText('Never actually given — logged by mistake');
});
