import 'fake-indexeddb/auto';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fromIso, toIso } from '@medguard/shared';
import type { Clock } from '@medguard/shared';
import type { MedGuardRepository } from '../../db/repository.js';
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
      patientId: 'patient-1',
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
      patientId: 'patient-1',
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
      patientId: 'patient-1',
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

    await renderWithRepository(<PrnScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedPrnMedicine(repository);
        await repository.recordDose({
          id: 'log-1',
          patientId: 'patient-1',
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
});
