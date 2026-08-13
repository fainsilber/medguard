import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Sprint 6 / A5 phase 2's round trip: a dose that fell inside Shabbat is unrecorded until, after
 * Havdalah, the app opens the reconciliation sheet and a caregiver says what happened.
 *
 * Runs against the real API (like `live-sync.spec.ts`) rather than stubbing it, because the
 * windows this depends on are computed server-side from the household's coordinates with
 * `@hebcal/core` — the point of phase 1 being that a client cannot invent one.
 *
 * Nothing here is pinned to a calendar date. The setup runs on the real clock, then reads the
 * *actual* published window out of the app's own IndexedDB and moves the browser clock to just
 * after that Havdalah. A daily schedule always has an occurrence inside a window (they are more
 * than a day long), so the dose needs no arithmetic either — which is what keeps this spec from
 * expiring the way a hardcoded 2026 date would.
 */

async function createHousehold(page: Page, householdName: string, displayName: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start a new household' }).click();
  await page.getByLabel('Household name').fill(householdName);
  await page.getByLabel('Your name').fill(displayName);
  await page.getByRole('button', { name: 'Create household' }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
}

async function addDailyMedicine(page: Page, name: string, strength: string) {
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('button', { name: 'Medicines' }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Strength').fill(strength);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(name, { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Schedule' }).click();
  await page.getByRole('button', { name: '+ Add schedule' }).click();
  await page.getByLabel('Time 1').fill('12:00');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('No active schedule.')).not.toBeVisible();
}

/** Turns on Shabbat automation and waits for the server's computed windows to arrive. */
async function enableShabbat(page: Page) {
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Shabbat' }).click();
  await page.getByRole('button', { name: 'Set up' }).click();
  await page.getByLabel('Switch to Shabbat behaviour automatically').check();
  await page.getByRole('button', { name: 'Save' }).click();

  // The list only renders once windows have been published and pulled back down.
  await expect(page.getByText(/One continuous period|→/).first()).toBeVisible({ timeout: 20_000 });
}

/**
 * The end of the first published window, read from the app's own database rather than parsed out
 * of the screen — the real instant the server computed, whatever week the suite happens to run in.
 */
async function firstHavdalahMs(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('MedGuardDB');
        request.onerror = () => reject(new Error('could not open MedGuardDB'));
        request.onsuccess = () => {
          const db = request.result;
          const all = db.transaction('shabbatWindows').objectStore('shabbatWindows').getAll();
          all.onerror = () => reject(new Error('could not read shabbatWindows'));
          all.onsuccess = () => {
            const ends = (all.result as { endsAt: string }[])
              .map((window) => new Date(window.endsAt).getTime())
              .sort((a, b) => a - b);
            if (ends.length === 0) {
              reject(new Error('no windows published'));
              return;
            }
            resolve(ends[0]!);
          };
        };
      }),
  );
}

test('after Havdalah the app opens the sheet, and confirming records the dose', async ({ page }) => {
  await createHousehold(page, 'The Cohens', 'Mom');
  await addDailyMedicine(page, 'Ondansetron', '4mg');
  await enableShabbat(page);

  // An hour after Havdalah: a caregiver opening the app once Shabbat is out.
  await page.clock.setFixedTime(new Date((await firstHavdalahMs(page)) + 60 * 60 * 1000));
  await page.reload();

  // Not asked for — PRD §3 has the app open the sheet itself.
  await expect(page.getByRole('heading', { name: 'Shabbat is over' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(/scheduled dose(s)? from Shabbat/)).toBeVisible();

  await page.getByRole('button', { name: 'All given as scheduled' }).click();

  // Nothing is owed any more, so the sheet gives the screen back on its own — no dismissing, no
  // second confirmation step.
  await expect(page.getByRole('heading', { name: 'Shabbat is over' })).not.toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();

  // And it stays gone across a relaunch.
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Shabbat is over' })).not.toBeVisible();

  // The dose is in the record.
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Log' }).click();
  await expect(page.getByText('Ondansetron', { exact: false }).first()).toBeVisible();
});

test('"Later" puts the sheet away for this device, and it stays away', async ({ page }) => {
  await createHousehold(page, 'The Levys', 'Dad');
  await addDailyMedicine(page, 'Paracetamol', '250mg');
  await enableShabbat(page);

  await page.clock.setFixedTime(new Date((await firstHavdalahMs(page)) + 60 * 60 * 1000));
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Shabbat is over' })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Later' }).click();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();

  // Dismissal is remembered per window, so the same device is not interrupted twice for the same
  // Shabbat — while the doses stay unreconciled and still visible on Today.
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Shabbat is over' })).not.toBeVisible();

  // The doses are still owed — dismissing is not answering — so the Shabbat tab still says so.
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Shabbat' }).click();
  await expect(page.getByRole('heading', { name: 'Shabbat & Yom Tov' })).toBeVisible({
    timeout: 20_000,
  });
});
