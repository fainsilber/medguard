import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBackupBundle } from '@medguard/shared';
import { fixedClock } from '@medguard/shared/testing';
import type { MedGuardRepository } from '../../db/repository.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { BackupRestoreCard } from './BackupRestoreCard.js';

let capturedBlob: Blob | undefined;

/** `Blob.prototype.text()` isn't available in this jsdom setup; `FileReader` is. */
function readBlobAsText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read blob'));
    reader.readAsText(blob);
  });
}

beforeEach(() => {
  capturedBlob = undefined;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    capturedBlob = blob;
    return 'blob:mock';
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

async function seedOneOfEverything(repository: MedGuardRepository) {
  await repository.saveMedicine(
    {
      id: 'medicine-1',
      patientId: 'patient-1',
      name: 'Ondansetron',
      strength: '4mg',
      form: 'pill',
      asNeeded: true,
      minHoursBetweenDoses: 4,
      archived: false,
      updatedAt: '2026-08-01T00:00:00.000Z',
      updatedByDeviceId: 'seed',
      syncStatus: 'synced',
    },
    'CREATE',
  );
  await repository.saveSchedule(
    {
      id: 'schedule-1',
      medicineId: 'medicine-1',
      patientId: 'patient-1',
      frequencyType: 'daily',
      timesOfDay: ['08:00'],
      dosageQuantity: 1,
      startDate: '2026-08-01',
      active: true,
      updatedAt: '2026-08-01T00:00:00.000Z',
      updatedByDeviceId: 'seed',
      syncStatus: 'synced',
    },
    'CREATE',
  );
  await repository.saveInventoryItem(
    {
      id: 'item-1',
      medicineId: 'medicine-1',
      refillThreshold: 5,
      unitName: 'pills',
      updatedAt: '2026-08-01T00:00:00.000Z',
      updatedByDeviceId: 'seed',
      syncStatus: 'synced',
    },
    'CREATE',
  );
  // recordDose() writes both a log and a paired inventory adjustment.
  await repository.recordDose({
    id: 'log-1',
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    type: 'prn',
    status: 'taken',
    actualTime: '2026-08-01T08:00:00.000Z',
    quantityTaken: 1,
    loggedByUserId: 'Mom',
    loggedByDeviceId: 'seed',
    syncStatus: 'synced',
  });
}

function backupFile(bundle: unknown, name = 'backup.json') {
  return new File([JSON.stringify(bundle)], name, { type: 'application/json' });
}

/**
 * The export click handler does real async Dexie reads with no state update in between, so
 * there's nothing in the DOM for `userEvent.click` to wait on. Polling for the blob is what
 * actually observes completion.
 */
async function downloadBackup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Download full backup' }));
  await waitFor(() => expect(capturedBlob).toBeDefined());
}

describe('BackupRestoreCard', () => {
  it('downloads a JSON backup containing every table', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      seed: seedOneOfEverything,
    });

    await downloadBackup(user);

    expect(capturedBlob).toBeDefined();
    expect(capturedBlob?.type).toContain('application/json');

    const bundle = JSON.parse(await readBlobAsText(capturedBlob!));
    expect(bundle).toMatchObject({
      version: 1,
      exportedAt: '2026-08-03T12:00:00.000Z',
      medicines: [expect.objectContaining({ id: 'medicine-1' })],
      schedules: [expect.objectContaining({ id: 'schedule-1' })],
      intakeLogs: [expect.objectContaining({ id: 'log-1' })],
      inventoryItems: [expect.objectContaining({ id: 'item-1' })],
    });
    expect(bundle.inventoryAdjustments).toHaveLength(1);
  });

  it('downloads an empty-but-valid backup when there is nothing to back up yet', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
    });

    await downloadBackup(user);

    const bundle = JSON.parse(await readBlobAsText(capturedBlob!));
    expect(bundle.medicines).toEqual([]);
  });

  it('previews record counts before writing anything, on a valid file', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
    });

    const bundle = buildBackupBundle(
      {
        medicines: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            patientId: '00000000-0000-4000-8000-000000000001',
            name: 'Ondansetron',
            strength: '4mg',
            form: 'pill',
            asNeeded: true,
            archived: false,
            updatedAt: '2026-08-01T00:00:00.000Z',
            updatedByDeviceId: 'other-device',
            syncStatus: 'synced',
          },
        ],
        schedules: [],
        intakeLogs: [],
        inventoryItems: [],
        inventoryAdjustments: [],
      },
      fixedClock('2026-08-01T00:00:00.000Z'),
    );

    await user.upload(screen.getByLabelText('Import backup file'), backupFile(bundle));

    expect(await screen.findByText('1 medicine(s)')).toBeInTheDocument();
    expect(screen.getByText('0 schedule(s)')).toBeInTheDocument();
    // Nothing written yet — only previewed.
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
  });

  it('writes the data only after the caregiver confirms the preview', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
    });

    const bundle = buildBackupBundle(
      {
        medicines: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            patientId: '00000000-0000-4000-8000-000000000001',
            name: 'Restored Medicine',
            strength: '4mg',
            form: 'pill',
            asNeeded: true,
            archived: false,
            updatedAt: '2026-08-01T00:00:00.000Z',
            updatedByDeviceId: 'other-device',
            syncStatus: 'synced',
          },
        ],
        schedules: [],
        intakeLogs: [],
        inventoryItems: [],
        inventoryAdjustments: [],
      },
      fixedClock('2026-08-01T00:00:00.000Z'),
    );

    await user.upload(screen.getByLabelText('Import backup file'), backupFile(bundle));
    await screen.findByText('1 medicine(s)');
    await user.click(screen.getByRole('button', { name: 'Import' }));

    expect(await screen.findByText('Backup imported.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
  });

  it('lets the caregiver cancel a preview without importing anything', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
    });

    const bundle = buildBackupBundle(
      {
        medicines: [],
        schedules: [],
        intakeLogs: [],
        inventoryItems: [],
        inventoryAdjustments: [],
      },
      fixedClock('2026-08-01T00:00:00.000Z'),
    );

    await user.upload(screen.getByLabelText('Import backup file'), backupFile(bundle));
    await screen.findByText('0 medicine(s)');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument();
    expect(screen.queryByText('Backup imported.')).not.toBeInTheDocument();
  });

  it('rejects a file that is not valid JSON, with a plain-language error', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
    });

    await user.upload(
      screen.getByLabelText('Import backup file'),
      new File(['not json at all'], 'backup.json', { type: 'application/json' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/not be read/);
  });

  it('rejects a file that is JSON but not a MedGuard backup, naming what failed', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
    });

    await user.upload(screen.getByLabelText('Import backup file'), backupFile({ hello: 'world' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Not a valid MedGuard backup/);
  });

  it('keeps the clear-all button disabled until the confirmation phrase is typed exactly', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      seed: seedOneOfEverything,
    });

    await user.click(screen.getByRole('button', { name: 'Clear all data on this device' }));

    const confirmButton = screen.getByRole('button', { name: 'Clear everything' });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'delete');
    expect(confirmButton).toBeDisabled();

    await user.clear(screen.getByLabelText('Type DELETE to confirm'));
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    expect(confirmButton).toBeEnabled();
  });

  it('clears all local data once confirmed', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      seed: seedOneOfEverything,
    });

    await user.click(screen.getByRole('button', { name: 'Clear all data on this device' }));
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await user.click(screen.getByRole('button', { name: 'Clear everything' }));

    expect(await screen.findByText('All local data cleared.')).toBeInTheDocument();
    // The confirm panel closes, so the initial trigger button reappears rather than a stale form.
    expect(
      screen.getByRole('button', { name: 'Clear all data on this device' }),
    ).toBeInTheDocument();

    // Confirm it actually wrote through: the exported backup should now be empty.
    await downloadBackup(user);
    const bundle = JSON.parse(await readBlobAsText(capturedBlob!));
    expect(bundle.medicines).toEqual([]);
    expect(bundle.intakeLogs).toEqual([]);
  });

  it('lets the caregiver back out of clearing without deleting anything', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      seed: seedOneOfEverything,
    });

    await user.click(screen.getByRole('button', { name: 'Clear all data on this device' }));
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('All local data cleared.')).not.toBeInTheDocument();

    await downloadBackup(user);
    const bundle = JSON.parse(await readBlobAsText(capturedBlob!));
    expect(bundle.medicines).toHaveLength(1);
  });
});
