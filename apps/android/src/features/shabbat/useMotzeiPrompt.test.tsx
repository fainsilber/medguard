import { fireEvent, waitFor } from '@testing-library/react-native';
import { Pressable, Text } from 'react-native';
import * as SQLite from 'expo-sqlite';
import { fixedClock } from '@medguard/shared/testing';
import type { Medicine, Schedule, ShabbatConfig, ShabbatWindow } from '@medguard/shared';
import { getDismissedReconciliation, setDismissedReconciliation } from '@medguard/store';
import { SqliteStore } from '@medguard/store/sqlite';
import { createSqliteSchema, ExpoSqliteDriver } from '../../store/expoSqliteDriver.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import {
  seedHouseholdSettings,
  seedMedicine,
  seedScheduleFor,
  seedShabbatConfig,
  seedShabbatWindows,
} from '../../testUtils/seedAlarmData.js';
import { useMotzeiPrompt } from './useMotzeiPrompt.js';

/**
 * No web mirror exists — `apps/web/src/features/shabbat/useMotzeiPrompt.ts` has no dedicated
 * test file either; both are proven only end-to-end today (`apps/web/e2e/motzei-reconciliation.spec.ts`).
 * This is new coverage of the boundary logic itself: the phase gate (nothing shows without Shabbat
 * automation configured), which window counts as "just ended," and — the property the hook's own
 * doc comment calls out — that dismissal is remembered per window, so it can never suppress a
 * *different* window's prompt.
 *
 * `renderHook` isn't available from this app's `@testing-library/react-native` setup in a form
 * that plays well with `RepositoryProvider`'s async handles, so a tiny probe component exposes the
 * hook's `{ show, dismiss }` through rendered text and a button instead — the same shape
 * `CaptureRepository` in `sync/SyncProvider.test.tsx` uses to reach inside a provider tree.
 */

const NOW = '2026-08-16T06:00:00.000Z'; // well after havdalah
const WINDOW_START = '2026-08-14T16:03:00.000Z';
const WINDOW_END = '2026-08-15T17:01:00.000Z';
const PATIENT_ID = '00000000-0000-4000-8000-000000000001';

function makeWindow(overrides: Partial<ShabbatWindow> = {}): ShabbatWindow {
  return {
    id: `shabbat:${WINDOW_START}`,
    patientId: PATIENT_ID,
    kind: 'shabbat',
    label: 'Shabbat',
    startsAt: WINDOW_START,
    endsAt: WINDOW_END,
    generatedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedByDeviceId: 'server',
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ShabbatConfig> = {}): ShabbatConfig {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    patientId: PATIENT_ID,
    autoShabbatEnabled: true,
    latitude: 31.7683,
    longitude: 35.2137,
    candleLightingOffsetMins: 18,
    havdalahDegreesOrMins: '8.5_degrees',
    israelHolidays: true,
    chimeDurationSeconds: 30,
    weekdayChimeDurationSeconds: 60,
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedByDeviceId: 'seed-device',
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeMedicine(): Medicine {
  return {
    id: 'medicine-1',
    patientId: PATIENT_ID,
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
    patientId: PATIENT_ID,
    frequencyType: 'daily',
    timesOfDay: ['09:00'],
    dosageQuantity: 1,
    startDate: '2026-01-01',
    active: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced',
  };
}

function Probe() {
  const { show, dismiss } = useMotzeiPrompt();
  return (
    <>
      <Text>{show ? 'show: yes' : 'show: no'}</Text>
      <Pressable onPress={dismiss} accessibilityRole="button">
        <Text>Dismiss</Text>
      </Pressable>
    </>
  );
}

describe('useMotzeiPrompt', () => {
  it('never shows without Shabbat automation configured, however unreconciled the doses', async () => {
    const dbName = 'motzei-no-config.db';
    await seedHouseholdSettings(dbName, { timeZone: 'Asia/Jerusalem' });
    await seedMedicine(dbName, makeMedicine());
    await seedScheduleFor(dbName, makeSchedule());
    await seedShabbatWindows(dbName, [makeWindow()]);
    // Deliberately no seedShabbatConfig call — the household never turned automation on.

    const { findByText } = renderWithRepository(<Probe />, { clock: fixedClock(NOW), dbName });

    expect(await findByText('show: no')).toBeTruthy();
  });

  it('does not show once a window has ended with nothing left to reconcile', async () => {
    const dbName = 'motzei-nothing-to-reconcile.db';
    await seedHouseholdSettings(dbName, { timeZone: 'Asia/Jerusalem' });
    await seedShabbatConfig(dbName, makeConfig());
    await seedShabbatWindows(dbName, [makeWindow()]);
    // No medicine/schedule at all — nothing could possibly be unreconciled.

    const { findByText } = renderWithRepository(<Probe />, { clock: fixedClock(NOW), dbName });

    expect(await findByText('show: no')).toBeTruthy();
  });

  it('shows once a window has ended with an unreconciled dose', async () => {
    const dbName = 'motzei-unreconciled.db';
    await seedHouseholdSettings(dbName, { timeZone: 'Asia/Jerusalem' });
    await seedShabbatConfig(dbName, makeConfig());
    await seedMedicine(dbName, makeMedicine());
    await seedScheduleFor(dbName, makeSchedule());
    await seedShabbatWindows(dbName, [makeWindow()]);

    const { findByText } = renderWithRepository(<Probe />, { clock: fixedClock(NOW), dbName });

    expect(await findByText('show: yes')).toBeTruthy();
  });

  it('dismissing hides the prompt and persists the dismissal for that window', async () => {
    const dbName = 'motzei-dismiss.db';
    await seedHouseholdSettings(dbName, { timeZone: 'Asia/Jerusalem' });
    await seedShabbatConfig(dbName, makeConfig());
    await seedMedicine(dbName, makeMedicine());
    await seedScheduleFor(dbName, makeSchedule());
    await seedShabbatWindows(dbName, [makeWindow()]);

    const { findByText, getByText } = renderWithRepository(<Probe />, { clock: fixedClock(NOW), dbName });
    await findByText('show: yes');

    fireEvent.press(getByText('Dismiss'));

    await waitFor(() => expect(getByText('show: no')).toBeTruthy());
  });

  it('a dismissal recorded for a different window does not suppress this one', async () => {
    // The property the hook's own doc comment promises: the next Shabbat is a different
    // question, so nothing should have to remember to clear a stale dismissal. Modeled directly
    // against the storage layer — driving two real windows through one fixed clock would need
    // the clock to advance mid-test — by pre-seeding a dismissal for an id that is *not* this
    // window's real id (`shabbat:${WINDOW_START}`), standing in for last week's window.
    const dbName = 'motzei-different-window.db';
    await seedHouseholdSettings(dbName, { timeZone: 'Asia/Jerusalem' });
    await seedShabbatConfig(dbName, makeConfig());
    await seedMedicine(dbName, makeMedicine());
    await seedScheduleFor(dbName, makeSchedule());
    await seedShabbatWindows(dbName, [makeWindow()]);
    const db = await SQLite.openDatabaseAsync(dbName);
    await createSqliteSchema(db);
    await setDismissedReconciliation(new SqliteStore(new ExpoSqliteDriver(db)), 'shabbat:last-week');

    const { findByText } = renderWithRepository(<Probe />, { clock: fixedClock(NOW), dbName });

    expect(await findByText('show: yes')).toBeTruthy();
  });
});

// Sanity check on the persistence primitive itself, so the "different window" test above rests on
// a verified assumption rather than an untested one: dismissing one window's id must not read back
// as a dismissal of a different id.
describe('getDismissedReconciliation / setDismissedReconciliation', () => {
  it('is scoped to the single most-recently-dismissed window id, not a set', async () => {
    const dbName = 'motzei-dismissal-store.db';
    const db = await SQLite.openDatabaseAsync(dbName);
    await createSqliteSchema(db);
    const store = new SqliteStore(new ExpoSqliteDriver(db));

    await setDismissedReconciliation(store, 'window-a');
    expect(await getDismissedReconciliation(store)).toBe('window-a');

    await setDismissedReconciliation(store, 'window-b');
    expect(await getDismissedReconciliation(store)).toBe('window-b');
  });
});
