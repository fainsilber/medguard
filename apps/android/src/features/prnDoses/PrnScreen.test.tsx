import { waitFor } from '@testing-library/react-native';
import type { Medicine, Schedule } from '@medguard/shared';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { seedMedicine, seedScheduleFor } from '../../testUtils/seedAlarmData.js';
import { PrnScreen } from './PrnScreen.js';

/**
 * RN port of `apps/web/src/features/prnDoses/PrnScreen.test.tsx` — the list/empty-state/filtering
 * behavior PrnScreen owns on top of what `PrnCard.test.tsx` already proves about the two-step
 * override flow itself.
 *
 * One thing here has no web equivalent and is Android-specific: unlike web (which has a real
 * server clock check wired up), this app has no server-verified `clockTrust` source yet, so
 * `PrnScreen` falls back to `clock/localClockGuard.ts`'s local guard whenever no `clockTrust` prop
 * is injected (`PrnCard.tsx`: `clockTrust ?? getLocalClockTrust()`). That guard's own default,
 * before any native sample has landed, is `trusted` — the same fail-open instant its own test file
 * proves — and this file is what proves the fallback is actually wired through the screen, not
 * just present in `PrnCard`'s signature.
 */

function makeMedicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'medicine-prn',
    patientId: 'patient-1',
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: true,
    // A cooldown/cap guard, matching web's `seedPrnMedicine` — `assessDose` only consults
    // clockTrust at all when a medicine has one (`hasGuard && !isClockTrusted(...)`), so a
    // guardless medicine would pass the skewed-clock test for the wrong reason.
    minHoursBetweenDoses: 4,
    archived: false,
    updatedAt: '2026-06-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeScheduledMedicine(): Medicine {
  return {
    id: 'medicine-scheduled',
    patientId: 'patient-1',
    name: 'Prednisone',
    strength: '20mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    updatedAt: '2026-06-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced',
  };
}

function makeSchedule(): Schedule {
  return {
    id: 'schedule-1',
    medicineId: 'medicine-scheduled',
    patientId: 'patient-1',
    frequencyType: 'daily',
    timesOfDay: ['08:00'],
    dosageQuantity: 1,
    startDate: '2026-06-01',
    active: true,
    updatedAt: '2026-06-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced',
  };
}

describe('PrnScreen', () => {
  it('shows an empty state when there are no as-needed medicines', async () => {
    const { findByText } = renderWithRepository(<PrnScreen />, { dbName: 'prn-screen-empty.db' });

    expect(await findByText('No as-needed medicines are set up yet.')).toBeTruthy();
  });

  it('shows a card for a PRN medicine but excludes one on an active schedule', async () => {
    const dbName = 'prn-screen-filter.db';
    await seedMedicine(dbName, makeMedicine());
    await seedMedicine(dbName, makeScheduledMedicine());
    await seedScheduleFor(dbName, makeSchedule());

    const { findByText, queryByText } = renderWithRepository(<PrnScreen />, { dbName });

    expect(await findByText('Ondansetron', { exact: false })).toBeTruthy();
    await waitFor(() => expect(queryByText('Prednisone', { exact: false })).toBeFalsy());
  });

  it('falls back to the local clock guard’s default trusted state when no clockTrust is injected', async () => {
    // No server-verified clock check exists on Android yet — see the module doc comment. Nothing
    // here mocks `localClockGuard`; this exercises the real fallback the same way production does.
    const dbName = 'prn-screen-fallback-trusted.db';
    await seedMedicine(dbName, makeMedicine());

    const { findByText, queryByText } = renderWithRepository(<PrnScreen />, { dbName });

    expect(await findByText('Give dose')).toBeTruthy();
    expect(queryByText('Clock unverified')).toBeFalsy();
  });

  it('blocks rather than showing green when an injected clockTrust is skewed', async () => {
    const dbName = 'prn-screen-skewed.db';
    await seedMedicine(dbName, makeMedicine());

    const { findByText, queryByRole } = renderWithRepository(
      <PrnScreen clockTrust={{ kind: 'skewed', offsetMs: 999_999 }} />,
      { dbName },
    );

    expect(await findByText('Clock unverified')).toBeTruthy();
    expect(queryByRole('button', { name: 'Give dose' })).toBeFalsy();
  });
});
