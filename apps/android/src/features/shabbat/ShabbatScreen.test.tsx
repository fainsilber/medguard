import { waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import type { ShabbatConfig, ShabbatWindow } from '@medguard/shared';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import {
  seedHouseholdSettings,
  seedShabbatConfig,
  seedShabbatWindows,
} from '../../testUtils/seedAlarmData.js';
import { ShabbatScreen } from './ShabbatScreen.js';

/**
 * The verification screen on native. Same guarantee as the web port: the times shown are the
 * server's, rendered in the household's timezone, and an empty list says which kind of empty it
 * is (Sprint A5).
 */

const NOW = '2026-08-13T09:00:00.000Z';

function makeWindow(overrides: Partial<ShabbatWindow> = {}): ShabbatWindow {
  const startsAt = overrides.startsAt ?? '2026-08-14T16:03:00.000Z';
  return {
    id: `shabbat:${startsAt}`,
    patientId: SINGLE_PATIENT_ID,
    kind: 'shabbat',
    label: 'Shabbat',
    startsAt,
    endsAt: '2026-08-15T17:01:00.000Z',
    generatedAt: NOW,
    updatedAt: NOW,
    updatedByDeviceId: 'server',
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ShabbatConfig> = {}): ShabbatConfig {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    patientId: SINGLE_PATIENT_ID,
    autoShabbatEnabled: true,
    latitude: 31.7683,
    longitude: 35.2137,
    candleLightingOffsetMins: 18,
    havdalahDegreesOrMins: '8.5_degrees',
    israelHolidays: true,
    chimeDurationSeconds: 30,
    weekdayChimeDurationSeconds: 60,
    updatedAt: NOW,
    updatedByDeviceId: 'seed-device',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('ShabbatScreen', () => {
  it('says it is not set up when the household has no coordinates', async () => {
    const { queryByText } = renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock(NOW),
      dbName: 'shabbat-screen-empty.db',
    });

    // Longer than the default budget: this is the first render in the file, so it also pays for
    // opening a brand-new database through the SQLite test double.
    await waitFor(() => expect(queryByText(/Not set up/)).toBeTruthy(), { timeout: 10_000 });
    expect(queryByText(/No times yet/)).toBeTruthy();
  });

  it('lists the published times in the household timezone', async () => {
    const dbName = 'shabbat-screen-windows.db';
    await seedHouseholdSettings(dbName, { timeZone: 'Asia/Jerusalem' });
    await seedShabbatConfig(dbName, makeConfig());
    await seedShabbatWindows(dbName, [
      makeWindow(),
      makeWindow({
        startsAt: '2026-09-11T15:30:00.000Z',
        endsAt: '2026-09-13T16:24:00.000Z',
        kind: 'combined',
        label: 'Shabbat · Rosh Hashana',
      }),
    ]);

    const { queryByText } = renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock(NOW),
      dbName,
    });

    // 16:03Z is 19:03 in Jerusalem — the household's zone, not the device's.
    await waitFor(() => expect(queryByText(/Fri 14 Aug/)).toBeTruthy());
    expect(queryByText('Shabbat · Rosh Hashana')).toBeTruthy();
    expect(queryByText(/One continuous period/)).toBeTruthy();
  });

  it('says so while Shabbat mode is on', async () => {
    const dbName = 'shabbat-screen-in-mode.db';
    await seedHouseholdSettings(dbName, { timeZone: 'Asia/Jerusalem' });
    await seedShabbatConfig(dbName, makeConfig());
    await seedShabbatWindows(dbName, [makeWindow()]);

    const { queryByText } = renderWithRepository(<ShabbatScreen />, {
      // Mid-window: Saturday morning.
      clock: fixedClock('2026-08-15T06:00:00.000Z'),
      dbName,
    });

    await waitFor(() => expect(queryByText('Shabbat mode is on.')).toBeTruthy());
  });

  it('does not claim Shabbat mode is on when automation is switched off', async () => {
    const dbName = 'shabbat-screen-disabled.db';
    await seedHouseholdSettings(dbName, { timeZone: 'Asia/Jerusalem' });
    await seedShabbatConfig(dbName, makeConfig({ autoShabbatEnabled: false }));
    await seedShabbatWindows(dbName, [makeWindow()]);

    const { queryByText } = renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock('2026-08-15T06:00:00.000Z'),
      dbName,
    });

    // The times are still listed — checking them is the point of the screen — but nothing behaves
    // differently, and the screen must not imply otherwise.
    await waitFor(() => expect(queryByText(/Fri 14 Aug/)).toBeTruthy());
    expect(queryByText('Shabbat mode is on.')).toBeNull();
  });
});
