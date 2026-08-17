import 'fake-indexeddb/auto';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SINGLE_PATIENT_ID, fromIso, toIso } from '@medguard/shared';
import type { Clock } from '@medguard/shared';
import type { MedGuardRepository } from '@medguard/store';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { PrnScreen } from './PrnScreen.js';

const TIME_ZONE = 'UTC';

afterEach(() => {
  localStorage.clear();
});

/** A clock whose reading can be advanced manually, so a live countdown can be driven forward
 * deterministically instead of depending on the real system clock. */
function manualClock(startIso: string): Clock & { advance: (ms: number) => void } {
  let ms = fromIso(startIso);
  return {
    nowMs: () => ms,
    nowIso: () => toIso(ms),
    advance: (deltaMs: number) => {
      ms += deltaMs;
    },
  };
}

async function seedPrnMedicine(repository: MedGuardRepository) {
  await repository.saveMedicine(
    {
      id: 'medicine-prn',
      patientId: SINGLE_PATIENT_ID,
      name: 'Ondansetron',
      strength: '4mg',
      form: 'pill',
      asNeeded: true,
      minHoursBetweenDoses: 4,
      archived: false,
      updatedAt: '2026-06-01T00:00:00.000Z',
      updatedByDeviceId: 'seed',
      syncStatus: 'synced',
    },
    'CREATE',
  );
}

async function seedScheduledMedicine(repository: MedGuardRepository) {
  await repository.saveMedicine(
    {
      id: 'medicine-scheduled',
      patientId: SINGLE_PATIENT_ID,
      name: 'Prednisone',
      strength: '20mg',
      form: 'pill',
      asNeeded: false,
      archived: false,
      updatedAt: '2026-06-01T00:00:00.000Z',
      updatedByDeviceId: 'seed',
      syncStatus: 'synced',
    },
    'CREATE',
  );
  await repository.saveSchedule(
    {
      id: 'schedule-1',
      medicineId: 'medicine-scheduled',
      patientId: SINGLE_PATIENT_ID,
      frequencyType: 'daily',
      timesOfDay: ['08:00'],
      dosageQuantity: 1,
      startDate: '2026-06-01',
      active: true,
      updatedAt: '2026-06-01T00:00:00.000Z',
      updatedByDeviceId: 'seed',
      syncStatus: 'synced',
    },
    'CREATE',
  );
}

describe('PrnScreen', () => {
  it('shows an empty state when there are no as-needed medicines', async () => {
    await renderWithRepository(<PrnScreen />, {
      clock: manualClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
    });

    expect(await screen.findByText('No as-needed medicines are set up yet.')).toBeInTheDocument();
  });

  it('shows a card for a PRN medicine but excludes one on an active schedule', async () => {
    await renderWithRepository(<PrnScreen />, {
      clock: manualClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedPrnMedicine(repository);
        await seedScheduledMedicine(repository);
      },
    });

    expect(await screen.findByText('Ondansetron', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('Prednisone', { exact: false })).not.toBeInTheDocument();
  });

  it('ticks a locked countdown down live as time advances, with a single shared interval', async () => {
    const clock = manualClock('2026-06-15T08:46:00.000Z');

    // Passed explicitly because there is no server here. Without it the screen correctly reports
    // the clock as unverified and blocks — see the fail-closed test below.
    await renderWithRepository(<PrnScreen clockTrust={{ kind: 'trusted', offsetMs: 0 }} />, {
      clock,
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedPrnMedicine(repository);
        await repository.recordDose({
          id: 'log-1',
          patientId: SINGLE_PATIENT_ID,
          medicineId: 'medicine-prn',
          type: 'prn',
          status: 'taken',
          actualTime: '2026-06-15T08:00:00.000Z',
          quantityTaken: 1,
          loggedByUserId: 'Dad',
          loggedByDeviceId: 'seed-device',
          syncStatus: 'synced',
        });
      },
    });

    expect(await screen.findByText('Locked: 3 hrs 14 mins remaining')).toBeInTheDocument();

    // Real (not faked) wall-clock wait for one tick of useTick's setInterval — the clock itself
    // is driven by `manualClock`, not by the passage of real time, so only the tick's re-render
    // needs to be genuinely awaited.
    clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(await screen.findByText('Locked: 3 hrs 13 mins remaining')).toBeInTheDocument();
  }, 8000);

  it('blocks rather than showing green when the clock cannot be verified against the server', async () => {
    // No server is reachable in this test, so the trust check can only return `unverified`. The
    // medicine is well outside its cooldown and would otherwise be safe — this asserts the app
    // fails closed (safety invariant 3) instead of trusting an unverifiable clock.
    await renderWithRepository(<PrnScreen />, {
      clock: manualClock('2026-06-16T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: seedPrnMedicine,
    });

    expect(await screen.findByText('🔴 Clock unverified')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Give dose' })).not.toBeInTheDocument();
  });
});

describe('PrnScreen — multi-patient', () => {
  function makePatient(id: string, displayName: string, sortOrder: number) {
    return {
      id,
      displayName,
      archived: false,
      sortOrder,
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedByDeviceId: 'seed',
      syncStatus: 'synced' as const,
    };
  }

  async function seedSharedPrnMedicine(repository: MedGuardRepository) {
    await repository.savePatient(makePatient('yoni', 'Yoni', 0), 'CREATE');
    await repository.savePatient(makePatient('dad', 'Dad', 1), 'CREATE');
    await repository.saveMedicine(
      {
        id: 'medicine-prn',
        name: 'Paracetamol',
        strength: '500mg',
        form: 'pill',
        asNeeded: true,
        minHoursBetweenDoses: 6,
        archived: false,
        updatedAt: '2026-06-01T00:00:00.000Z',
        updatedByDeviceId: 'seed',
        syncStatus: 'synced',
      },
      'CREATE',
    );
    await repository.assignMedicine('medicine-prn', 'yoni');
    await repository.assignMedicine('medicine-prn', 'dad');
  }

  it('renders one card per assigned patient, each independently scoped', async () => {
    await renderWithRepository(<PrnScreen clockTrust={{ kind: 'trusted', offsetMs: 0 }} />, {
      clock: manualClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedSharedPrnMedicine(repository);
        // Yoni took a dose an hour ago — well inside the 6h cooldown. Dad has never taken one.
        await repository.recordDose({
          id: 'yoni-dose',
          patientId: 'yoni',
          medicineId: 'medicine-prn',
          type: 'prn',
          status: 'taken',
          actualTime: '2026-06-15T11:00:00.000Z',
          quantityTaken: 1,
          loggedByUserId: 'Mom',
          loggedByDeviceId: 'seed-device',
          syncStatus: 'synced',
        });
      },
    });

    const yoniCard = (await screen.findByText('Yoni')).closest('section')!;
    const dadCard = screen.getByText('Dad').closest('section')!;

    expect(yoniCard.textContent).toContain('Locked');
    expect(dadCard.textContent).toContain('Safe to take');
  });

  it('shows only the selected patient’s card, with no badge', async () => {
    localStorage.setItem('medguard.selectedPatientId', 'yoni');

    await renderWithRepository(<PrnScreen clockTrust={{ kind: 'trusted', offsetMs: 0 }} />, {
      clock: manualClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: seedSharedPrnMedicine,
    });

    await screen.findByText('Paracetamol', { exact: false });
    expect(screen.queryByText('Yoni')).not.toBeInTheDocument();
    expect(screen.queryByText('Dad')).not.toBeInTheDocument();
    expect(screen.getAllByText('Paracetamol', { exact: false })).toHaveLength(1);
  });
});
