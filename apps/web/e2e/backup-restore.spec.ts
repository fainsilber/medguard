import { expect, test } from '@playwright/test';

/**
 * The full backup round trip in a real browser, against a real download and a real file upload —
 * the parts a component test can't reach, since jsdom has neither.
 *
 * Runs entirely offline, like offline-smoke.spec.ts: this is local device data, independent of
 * any backend.
 */
test('export a backup, clear all data, and restore it from the file', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Use this device on its own for now' }).click();
  await page.getByPlaceholder('e.g. Mom, Dad, Grandma').fill('Mom');
  await page.getByRole('button', { name: 'Continue' }).click();

  const nav = page.getByRole('navigation', { name: 'Sections' });

  // Create one medicine so the backup has something in it.
  await nav.getByRole('button', { name: 'Medicines' }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Name').fill('Ondansetron');
  await page.getByLabel('Strength').fill('4mg');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Ondansetron', { exact: false })).toBeVisible();

  await nav.getByRole('button', { name: 'Log' }).click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download full backup' }).click();
  const download = await downloadPromise;

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const backupJson = Buffer.concat(chunks).toString('utf-8');
  const backup: { medicines: { name: string }[] } = JSON.parse(backupJson);
  expect(backup.medicines).toHaveLength(1);
  expect(backup.medicines[0]?.name).toBe('Ondansetron');

  // Wipe everything, confirming the double-check actually gates the button.
  await page.getByRole('button', { name: 'Clear all data on this device' }).click();
  const confirmButton = page.getByRole('button', { name: 'Clear everything' });
  await expect(confirmButton).toBeDisabled();
  await page.getByLabel('Type DELETE to confirm').fill('DELETE');
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await expect(page.getByText('All local data cleared.')).toBeVisible();

  await nav.getByRole('button', { name: 'Medicines' }).click();
  await expect(page.getByText('No medicines yet.')).toBeVisible();
  await expect(page.getByText('Ondansetron', { exact: false })).not.toBeVisible();

  // Restore from the exact file just downloaded.
  await nav.getByRole('button', { name: 'Log' }).click();
  await page.getByLabel('Import backup file').setInputFiles({
    name: 'medguard-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(backupJson, 'utf-8'),
  });

  await expect(page.getByText('1 medicine(s)')).toBeVisible();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText('Backup imported.')).toBeVisible();

  await nav.getByRole('button', { name: 'Medicines' }).click();
  await expect(page.getByText('Ondansetron', { exact: false })).toBeVisible();
});

test('rejects a file that is not a MedGuard backup, without touching existing data', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Use this device on its own for now' }).click();
  await page.getByPlaceholder('e.g. Mom, Dad, Grandma').fill('Mom');
  await page.getByRole('button', { name: 'Continue' }).click();

  const nav = page.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('button', { name: 'Medicines' }).click();
  await page.getByRole('button', { name: '+ Add medicine' }).click();
  await page.getByLabel('Name').fill('Prednisone');
  await page.getByLabel('Strength').fill('20mg');
  await page.getByRole('button', { name: 'Save' }).click();

  await nav.getByRole('button', { name: 'Log' }).click();
  await page.getByLabel('Import backup file').setInputFiles({
    name: 'not-a-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"hello":"world"}', 'utf-8'),
  });

  await expect(page.getByRole('alert')).toContainText('Not a valid MedGuard backup');

  await nav.getByRole('button', { name: 'Medicines' }).click();
  await expect(page.getByText('Prednisone', { exact: false })).toBeVisible();
});
