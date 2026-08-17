// jest-expo's own preset already registers a `jest.mock('expo-file-system/legacy', ...)` with a
// no-op stub (no `cacheDirectory` at all) in its setupFiles — a `moduleNameMapper` entry for it in
// jest.config.js would just be shadowed, so it isn't one (see the comment there). Re-registering
// the mock here, from the test file itself, wins: it runs after the preset's setupFiles, and this
// is the one file in the suite that needs `expo-file-system/legacy` to be a real, stateful double
// rather than the preset's inert stub.
jest.mock('expo-file-system/legacy', () => require('../../testUtils/mockExpoFileSystem.ts'));

import { fireEvent, waitFor } from '@testing-library/react-native';
import { buildBackupBundle } from '@medguard/shared';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import { MedGuardRepository } from '@medguard/store';
import { SqliteStore } from '@medguard/store/sqlite';
import * as DocumentPicker from 'expo-document-picker';
import * as SQLite from 'expo-sqlite';
import * as Sharing from 'expo-sharing';
import { createSqliteSchema, ExpoSqliteDriver } from '../../store/expoSqliteDriver.js';
import { readSeededFile, seedFile } from '../../testUtils/mockExpoFileSystem.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { BackupRestoreCard } from './BackupRestoreCard.js';

/**
 * RN port of `apps/web/src/features/export/BackupRestoreCard.test.tsx`. I/O is the one place this
 * genuinely differs from web (the component's own doc comment): there's no `<input type=file>` or
 * browser download here, so export goes through `shareTextFile.ts` (write to cache, hand to the OS
 * share sheet) and import goes through `expo-document-picker` + `expo-file-system`'s
 * `readAsStringAsync`. New test doubles for all three
 * (`testUtils/mockExpoDocumentPicker.ts`/`mockExpoFileSystem.ts`/`mockExpoSharing.ts`) stand in for
 * native pickers/dialogs with no headless equivalent under Jest. The state machine underneath —
 * idle / previewing / error, with an explicit confirm step before `restoreBackup` ever runs — is
 * otherwise unchanged, so this covers the same behavior web's version does.
 */

function pickedFile(uri: string, content: string) {
  seedFile(uri, content);
  (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValueOnce({
    canceled: false,
    assets: [{ uri, name: 'backup.json' }],
  });
}

/** Opens a second repository against the same (mocked, shared-by-name) database `renderWithRepository`
 * will open, so seed data is in place before the component mounts — `renderWithRepository` here
 * has no `seed` callback the way web's does. Same pattern as `readLogs.ts`/`seedAlarmData.ts`. */
async function seedOneOfEverything(dbName: string): Promise<void> {
  const db = await SQLite.openDatabaseAsync(dbName);
  await createSqliteSchema(db);
  const repository = new MedGuardRepository(new SqliteStore(new ExpoSqliteDriver(db)), {
    clock: fixedClock('2026-08-01T00:00:00.000Z'),
    ids: sequentialIds('seed'),
    userId: 'seed',
    deviceId: 'seed',
  });

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

async function shareBackup(getByText: (text: string) => unknown) {
  fireEvent.press(getByText('Share full backup') as never);
  await waitFor(() => expect(Sharing.shareAsync as jest.Mock).toHaveBeenCalled());
  const [uri] = (Sharing.shareAsync as jest.Mock).mock.calls.at(-1) as [string];
  return JSON.parse(readSeededFile(uri)!);
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('BackupRestoreCard', () => {
  it('shares a JSON backup containing every table', async () => {
    const dbName = 'backup-restore-full.db';
    await seedOneOfEverything(dbName);
    const { getByText } = renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      dbName,
    });
    await waitFor(() => expect(getByText('Share full backup')).toBeTruthy());

    const bundle = await shareBackup(getByText);

    expect(bundle).toMatchObject({
      version: 2,
      exportedAt: '2026-08-03T12:00:00.000Z',
      medicines: [expect.objectContaining({ id: 'medicine-1' })],
      schedules: [expect.objectContaining({ id: 'schedule-1' })],
      intakeLogs: [expect.objectContaining({ id: 'log-1' })],
      inventoryItems: [expect.objectContaining({ id: 'item-1' })],
    });
    expect(bundle.inventoryAdjustments).toHaveLength(1);
  });

  it('shares an empty-but-valid backup when there is nothing to back up yet', async () => {
    const { getByText } = renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      dbName: 'backup-restore-empty.db',
    });
    await waitFor(() => expect(getByText('Share full backup')).toBeTruthy());

    const bundle = await shareBackup(getByText);

    expect(bundle.medicines).toEqual([]);
  });

  it('previews record counts before writing anything, on a valid file', async () => {
    const { getByText, findByText } = renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      dbName: 'backup-restore-preview.db',
    });
    await waitFor(() => expect(getByText('Import backup…')).toBeTruthy());

    const bundle = buildBackupBundle(
      {
        patients: [],
        medicinePatients: [],
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
    pickedFile('picked://backup.json', JSON.stringify(bundle));
    fireEvent.press(getByText('Import backup…'));

    expect(await findByText('1 medicine(s)')).toBeTruthy();
    expect(getByText('0 schedule(s)')).toBeTruthy();
    // Nothing written yet — only previewed.
    expect(getByText('Import')).toBeTruthy();
  });

  it('writes the data only after the caregiver confirms the preview', async () => {
    const dbName = 'backup-restore-confirm.db';
    const { getByText, findByText, queryByText } = renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      dbName,
    });
    await waitFor(() => expect(getByText('Import backup…')).toBeTruthy());

    const bundle = buildBackupBundle(
      {
        patients: [],
        medicinePatients: [],
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
    pickedFile('picked://backup.json', JSON.stringify(bundle));
    fireEvent.press(getByText('Import backup…'));
    await findByText('1 medicine(s)');
    fireEvent.press(getByText('Import'));

    expect(await findByText('Backup imported.')).toBeTruthy();
    expect(queryByText('Import')).toBeFalsy();
  });

  it('lets the caregiver cancel a preview without importing anything', async () => {
    const { getByText, findByText, queryByText } = renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      dbName: 'backup-restore-cancel-preview.db',
    });
    await waitFor(() => expect(getByText('Import backup…')).toBeTruthy());

    const bundle = buildBackupBundle(
      {
        patients: [],
        medicinePatients: [],
        medicines: [],
        schedules: [],
        intakeLogs: [],
        inventoryItems: [],
        inventoryAdjustments: [],
      },
      fixedClock('2026-08-01T00:00:00.000Z'),
    );
    pickedFile('picked://backup.json', JSON.stringify(bundle));
    fireEvent.press(getByText('Import backup…'));
    await findByText('0 medicine(s)');
    fireEvent.press(getByText('Cancel'));

    expect(queryByText('Import')).toBeFalsy();
    expect(queryByText('Backup imported.')).toBeFalsy();
  });

  it('rejects a file that is not valid JSON, with a plain-language error', async () => {
    const { getByText, findByText } = renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      dbName: 'backup-restore-bad-json.db',
    });
    await waitFor(() => expect(getByText('Import backup…')).toBeTruthy());

    pickedFile('picked://backup.json', 'not json at all');
    fireEvent.press(getByText('Import backup…'));

    expect(await findByText(/not be read/)).toBeTruthy();
  });

  it('rejects a file that is JSON but not a MedGuard backup, naming what failed', async () => {
    const { getByText, findByText } = renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      dbName: 'backup-restore-bad-shape.db',
    });
    await waitFor(() => expect(getByText('Import backup…')).toBeTruthy());

    pickedFile('picked://backup.json', JSON.stringify({ hello: 'world' }));
    fireEvent.press(getByText('Import backup…'));

    expect(await findByText(/Not a valid MedGuard backup/)).toBeTruthy();
  });

  it('keeps the clear-all button disabled until the confirmation phrase is typed exactly', async () => {
    const dbName = 'backup-restore-clear-gate.db';
    await seedOneOfEverything(dbName);
    const { getByText, getByLabelText, getByRole } = renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      dbName,
    });
    await waitFor(() => expect(getByText('Clear all data on this device')).toBeTruthy());

    fireEvent.press(getByText('Clear all data on this device'));

    const confirmField = getByLabelText('Type DELETE to confirm');
    const confirmButtonDisabled = () =>
      getByRole('button', { name: 'Clear everything' }).props.accessibilityState?.disabled;
    fireEvent.changeText(confirmField, 'delete');
    expect(confirmButtonDisabled()).toBe(true);

    fireEvent.changeText(confirmField, 'DELETE');
    expect(confirmButtonDisabled()).toBeFalsy();
  });

  it('clears all local data once confirmed', async () => {
    const dbName = 'backup-restore-clear.db';
    await seedOneOfEverything(dbName);
    const { getByText, findByText, getByLabelText } = renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      dbName,
    });
    await waitFor(() => expect(getByText('Clear all data on this device')).toBeTruthy());

    fireEvent.press(getByText('Clear all data on this device'));
    fireEvent.changeText(getByLabelText('Type DELETE to confirm'), 'DELETE');
    fireEvent.press(getByText('Clear everything'));

    expect(await findByText('All local data cleared.')).toBeTruthy();
    // The confirm panel closes, so the initial trigger button reappears rather than a stale form.
    expect(getByText('Clear all data on this device')).toBeTruthy();

    // Confirm it actually wrote through: the shared backup should now be empty.
    const bundle = await shareBackup(getByText);
    expect(bundle.medicines).toEqual([]);
    expect(bundle.intakeLogs).toEqual([]);
  });

  it('lets the caregiver back out of clearing without deleting anything', async () => {
    const dbName = 'backup-restore-clear-cancel.db';
    await seedOneOfEverything(dbName);
    const { getByText, getByLabelText } = renderWithRepository(<BackupRestoreCard />, {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      dbName,
    });
    await waitFor(() => expect(getByText('Clear all data on this device')).toBeTruthy());

    fireEvent.press(getByText('Clear all data on this device'));
    fireEvent.changeText(getByLabelText('Type DELETE to confirm'), 'DELETE');
    fireEvent.press(getByText('Cancel'));

    const bundle = await shareBackup(getByText);
    expect(bundle.medicines).toHaveLength(1);
  });
});
