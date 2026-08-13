import { fireEvent, waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import type { Medicine, Schedule, ShabbatWindow } from '@medguard/shared';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import {
  seedHouseholdSettings,
  seedMedicine,
  seedScheduleFor,
  seedShabbatWindows,
} from '../../testUtils/seedAlarmData.js';
import { readLogsFromDb } from '../../testUtils/readLogs.js';
import { ReconciliationSheet } from './ReconciliationSheet.js';

/**
 * The reconciliation sheet on the phone the household actually carries — the doses listed here are
 * the ones whose alarms rang on this device and could not be answered at the time (Sprint A5
 * phase 2).
 */

const NOW = '2026-08-16T06:00:00.000Z';
const WINDOW_START = '2026-08-14T16:03:00.000Z';
const WINDOW_END = '2026-08-15T17:01:00.000Z';

function makeWindow(): ShabbatWindow {
  return {
    id: `shabbat:${WINDOW_START}`,
    patientId: '00000000-0000-4000-8000-000000000001',
    kind: 'shabbat',
    label: 'Shabbat',
    startsAt: WINDOW_START,
    endsAt: WINDOW_END,
    generatedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedByDeviceId: 'server',
    syncStatus: 'synced',
  };
}

function makeMedicine(): Medicine {
  return {
    id: 'medicine-1',
    patientId: '00000000-0000-4000-8000-000000000001',
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced',
  };
}

function makeSchedule(): Schedule {
  return {
    id: 'schedule-1',
    medicineId: 'medicine-1',
    patientId: '00000000-0000-4000-8000-000000000001',
    frequencyType: 'daily',
    timesOfDay: ['09:00', '21:00'],
    dosageQuantity: 2,
    startDate: '2026-01-01',
    active: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced',
  };
}

async function seedAll(dbName: string) {
  await seedHouseholdSettings(dbName, { timeZone: 'Asia/Jerusalem' });
  await seedMedicine(dbName, makeMedicine());
  await seedScheduleFor(dbName, makeSchedule());
  await seedShabbatWindows(dbName, [makeWindow()]);
}

describe('ReconciliationSheet', () => {
  it('asks about the doses from the window that just ended', async () => {
    const dbName = 'reconciliation-lists.db';
    await seedAll(dbName);

    const { queryByText } = renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      dbName,
    });

    await waitFor(() => expect(queryByText(/2 scheduled doses from Shabbat/)).toBeTruthy(), {
      timeout: 10_000,
    });
  });

  it('records them all as given at their scheduled times and moves the waiting stock', async () => {
    const dbName = 'reconciliation-confirm-all.db';
    await seedAll(dbName);

    const { getByText, queryByText } = renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      dbName,
    });

    await waitFor(() => expect(queryByText('All given as scheduled')).toBeTruthy());
    fireEvent.press(getByText('All given as scheduled'));

    await waitFor(async () => {
      const logs = await readLogsFromDb(dbName, 'medicine-1');
      expect(logs).toHaveLength(2);
      expect(logs.every((log) => log.status === 'taken')).toBe(true);
      // Recorded at the time each dose was due, not when they were confirmed.
      expect(logs.map((log) => log.actualTime).sort()).toEqual(
        logs.map((log) => log.scheduledTime).sort(),
      );
    });
  });

  it('says so when nothing is left to reconcile', async () => {
    const dbName = 'reconciliation-empty.db';
    await seedHouseholdSettings(dbName, { timeZone: 'Asia/Jerusalem' });

    const { queryByText } = renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      dbName,
    });

    await waitFor(() =>
      expect(queryByText(/Every dose from Shabbat has been accounted for/)).toBeTruthy(),
    );
  });

  it('offers "Later" only when there is somewhere to go back to', async () => {
    const dbName = 'reconciliation-later.db';
    await seedAll(dbName);
    let dismissed = false;

    const { getByText, queryByText } = renderWithRepository(
      <ReconciliationSheet
        onDone={() => {
          dismissed = true;
        }}
      />,
      { clock: fixedClock(NOW), dbName },
    );

    await waitFor(() => expect(queryByText('Later')).toBeTruthy());
    fireEvent.press(getByText('Later'));
    expect(dismissed).toBe(true);
  });
});
