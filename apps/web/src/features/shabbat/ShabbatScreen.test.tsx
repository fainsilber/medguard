import 'fake-indexeddb/auto';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import type { ShabbatConfig, ShabbatWindow } from '@medguard/shared';
import type { MedGuardRepository, Store } from '@medguard/store';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { ShabbatScreen } from './ShabbatScreen.js';

/**
 * The verification screen is the sprint's own exit gate — eight weeks of times, checked against a
 * luach — so what is asserted here is that the times shown are the *server's*, rendered in the
 * *household's* timezone, and that an empty list reads as "not computed yet" rather than as "no
 * Shabbat this month".
 */

const NOW = '2026-08-13T09:00:00.000Z';
const JERUSALEM = 'Asia/Jerusalem';

afterEach(() => {
  localStorage.clear();
});

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

/** Windows arrive from the server, so they are written straight to the store, as a pull does. */
async function putWindows(store: Store, windows: ShabbatWindow[]) {
  await store.transaction(['shabbatWindows'], async (tx) => {
    for (const window of windows) {
      await tx.put('shabbatWindows', window);
    }
  });
}

describe('ShabbatScreen', () => {
  /**
   * The heading is what tells a caregiver which screen they are on, and it depends on nothing.
   * It used to sit behind a guard that withheld the entire screen until the published Shabbat
   * windows had been read out of IndexedDB — so on a loaded machine the tab could look blank for
   * as long as that read took. The Motzei e2e spec was failing on exactly that wait, and had been
   * given a longer and longer timeout in response; this pins the real property instead.
   */
  it('shows the heading immediately, before any data has been read', async () => {
    await renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
    });

    // Deliberately synchronous — no `find*`, no `waitFor`. If the heading needed a query to
    // resolve first, this is the assertion that would fail.
    expect(screen.getByRole('heading', { name: 'Shabbat & Yom Tov' })).toBeInTheDocument();
  });

  /**
   * "Not read yet" and "genuinely not configured" must not look alike: telling a household that
   * *is* set up that it is not, even for a moment, is a false statement about whether their
   * Shabbat alarms work.
   */
  it('never claims a configured household is not set up while the config is still loading', async () => {
    await renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (repository) => {
        await repository.saveShabbatConfig(makeConfig(), 'CREATE');
      },
    });

    expect(screen.queryByText(/Not set up/)).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Latitude')).toBeInTheDocument();
    expect(screen.queryByText(/Not set up/)).not.toBeInTheDocument();
  });

  it('says it is not set up when the household has no coordinates', async () => {
    await renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
    });

    expect(await screen.findByText(/Not set up/)).toBeInTheDocument();
    // Awaited separately from the form above: the two halves of this screen no longer load
    // together. The settings form renders immediately, while the published-times list waits on
    // its own read — which is the point, so that the form is not held hostage to it.
    expect(await screen.findByText(/No times yet/)).toBeInTheDocument();
  });

  it('creates a configuration and queues it for sync', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;

    await renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (seedRepository) => {
        repository = seedRepository;
      },
    });

    await user.click(await screen.findByRole('button', { name: 'Set up' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const outbox = await repository!.pendingSync();
    const shabbat = outbox.filter((entry) => entry.table === 'shabbatConfig');
    expect(shabbat).toHaveLength(1);
    expect(shabbat[0]!.action).toBe('CREATE');

    const saved = await repository!.getShabbatConfig();
    // Automation starts off: nothing changes how alarms behave until the times have been checked.
    expect(saved).toMatchObject({ autoShabbatEnabled: false, candleLightingOffsetMins: 18 });
  });

  it('edits every setting and saves them as one record', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;

    await renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (seedRepository) => {
        repository = seedRepository;
        await seedRepository.saveShabbatConfig(makeConfig({ autoShabbatEnabled: false }), 'CREATE');
      },
    });

    const latitude = await screen.findByLabelText('Latitude');
    await user.clear(latitude);
    await user.type(latitude, '32.0853');

    const longitude = screen.getByLabelText('Longitude');
    await user.clear(longitude);
    await user.type(longitude, '34.7818');

    const offset = screen.getByLabelText(/Candle lighting, minutes before sunset/);
    await user.clear(offset);
    await user.type(offset, '40');

    const havdalah = screen.getByLabelText(/^Havdalah/);
    await user.clear(havdalah);
    await user.type(havdalah, '50_mins');

    const weekdayChime = screen.getByLabelText('Weekday alert length, seconds');
    await user.clear(weekdayChime);
    await user.type(weekdayChime, '90');

    const shabbatChime = screen.getByLabelText('Shabbat alert length, seconds');
    await user.clear(shabbatChime);
    await user.type(shabbatChime, '20');

    await user.click(screen.getByLabelText('In Israel (one day of Yom Tov rather than two)'));
    await user.click(screen.getByLabelText('Switch to Shabbat behaviour automatically'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await repository!.getShabbatConfig()).toMatchObject({
      latitude: 32.0853,
      longitude: 34.7818,
      candleLightingOffsetMins: 40,
      havdalahDegreesOrMins: '50_mins',
      // The two alert lengths are independent settings, saved on the one record.
      weekdayChimeDurationSeconds: 90,
      chimeDurationSeconds: 20,
      israelHolidays: false,
      autoShabbatEnabled: true,
    });
  });

  it('abandons an edit on Reset rather than saving half of it', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;

    await renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (seedRepository) => {
        repository = seedRepository;
        await seedRepository.saveShabbatConfig(makeConfig(), 'CREATE');
      },
    });

    const offset = await screen.findByLabelText(/Candle lighting, minutes before sunset/);
    await user.clear(offset);
    await user.type(offset, '99');
    await user.click(screen.getByRole('button', { name: 'Reset' }));

    expect(await screen.findByLabelText(/Candle lighting, minutes before sunset/)).toHaveValue(18);
    expect(await repository!.getShabbatConfig()).toMatchObject({
      candleLightingOffsetMins: 18,
    });
  });

  it('lists the published times in the household timezone', async () => {
    await renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (repository, store) => {
        await repository.saveShabbatConfig(makeConfig(), 'CREATE');
        await putWindows(store, [
          makeWindow(),
          makeWindow({
            startsAt: '2026-09-11T15:30:00.000Z',
            endsAt: '2026-09-13T16:24:00.000Z',
            kind: 'combined',
            label: 'Shabbat · Rosh Hashana',
          }),
        ]);
      },
    });

    // 16:03Z is 19:03 in Jerusalem — the household's zone, not the device's.
    expect(await screen.findByText(/Fri 14 Aug · 19:03/)).toBeInTheDocument();
    expect(screen.getByText(/Sat 15 Aug · 20:01/)).toBeInTheDocument();
    expect(screen.getByText('Shabbat · Rosh Hashana')).toBeInTheDocument();
    expect(screen.getByText(/One continuous period/)).toBeInTheDocument();
  });

  it('distinguishes "nothing published yet" from "no Shabbat coming"', async () => {
    await renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (repository) => {
        await repository.saveShabbatConfig(makeConfig(), 'CREATE');
      },
    });

    expect(await screen.findByText(/No times published yet/)).toBeInTheDocument();
  });

  it('drops windows that have already ended', async () => {
    await renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (repository, store) => {
        await repository.saveShabbatConfig(makeConfig(), 'CREATE');
        await putWindows(store, [
          makeWindow({
            startsAt: '2026-08-07T16:12:00.000Z',
            endsAt: '2026-08-08T17:10:00.000Z',
          }),
          makeWindow(),
        ]);
      },
    });

    expect(await screen.findByText(/Fri 14 Aug/)).toBeInTheDocument();
    expect(screen.queryByText(/Fri 7 Aug/)).not.toBeInTheDocument();
  });

  it('says so while Shabbat mode is on', async () => {
    await renderWithRepository(<ShabbatScreen />, {
      // Mid-window: Saturday morning.
      clock: fixedClock('2026-08-15T06:00:00.000Z'),
      timeZone: JERUSALEM,
      seed: async (repository, store) => {
        await repository.saveShabbatConfig(makeConfig(), 'CREATE');
        await putWindows(store, [makeWindow()]);
      },
    });

    expect(await screen.findByText('Shabbat mode is on.')).toBeInTheDocument();
    expect(screen.getByText(/logged after Havdalah/)).toBeInTheDocument();
  });

  it('does not claim Shabbat mode is on when automation is switched off', async () => {
    await renderWithRepository(<ShabbatScreen />, {
      clock: fixedClock('2026-08-15T06:00:00.000Z'),
      timeZone: JERUSALEM,
      seed: async (repository, store) => {
        await repository.saveShabbatConfig(makeConfig({ autoShabbatEnabled: false }), 'CREATE');
        await putWindows(store, [makeWindow()]);
      },
    });

    // The times are still listed — checking them is the point of the screen — but nothing behaves
    // differently, and the screen must not imply otherwise.
    expect(await screen.findByText(/Fri 14 Aug/)).toBeInTheDocument();
    expect(screen.queryByText('Shabbat mode is on.')).not.toBeInTheDocument();
  });
});
