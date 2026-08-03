import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import type { MedGuardRepository } from '../../db/repository.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { TodayView } from './TodayView.js';

const TIME_ZONE = 'UTC';

afterEach(() => {
  localStorage.clear();
});

async function seedMedicineAndSchedule(
  repository: MedGuardRepository,
  scheduleOverrides: { timesOfDay?: string[] } = {},
) {
  await repository.saveMedicine(
    {
      id: 'medicine-1',
      patientId: 'patient-1',
      name: 'Ondansetron',
      strength: '4mg',
      form: 'pill',
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
      medicineId: 'medicine-1',
      patientId: 'patient-1',
      frequencyType: 'daily',
      timesOfDay: scheduleOverrides.timesOfDay ?? ['08:00'],
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

describe('TodayView', () => {
  it('shows nothing scheduled when there are no schedules', async () => {
    await renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T08:00:00.000Z'),
      timeZone: TIME_ZONE,
    });

    expect(await screen.findByText('Nothing scheduled today.')).toBeInTheDocument();
  });

  it('shows a dose exactly at its due time as due now', async () => {
    await renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T08:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => seedMedicineAndSchedule(repository),
    });

    expect(await screen.findByText('Due now')).toBeInTheDocument();
    expect(screen.getByText('Ondansetron 4mg')).toBeInTheDocument();
  });

  it('shows a dose past the grace window as overdue', async () => {
    await renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T08:06:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => seedMedicineAndSchedule(repository),
    });

    expect(await screen.findByText('Overdue')).toBeInTheDocument();
  });

  it('shows a dose later today as upcoming', async () => {
    await renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T08:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => seedMedicineAndSchedule(repository, { timesOfDay: ['20:00'] }),
    });

    expect(await screen.findByText('Upcoming')).toBeInTheDocument();
  });

  it('marks a dose taken and moves it to done', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T08:00:00.000Z'),
      timeZone: TIME_ZONE,
      userId: 'Mom',
      seed: (repository) => seedMedicineAndSchedule(repository),
    });

    await screen.findByText('Due now');
    await user.click(screen.getByRole('button', { name: 'Taken' }));

    await waitFor(() => expect(screen.queryByText('Due now')).not.toBeInTheDocument());
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Taken by Mom')).toBeInTheDocument();
  });

  it('marks a dose skipped and moves it to done, with no "taken" wording', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T08:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => seedMedicineAndSchedule(repository),
    });

    await screen.findByText('Due now');
    await user.click(screen.getByRole('button', { name: 'Skip' }));

    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument());
    expect(screen.getByText(/Skipped by/)).toBeInTheDocument();
  });

  it('snoozes an overdue dose out of the urgent buckets', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T08:06:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => seedMedicineAndSchedule(repository),
    });

    await screen.findByText('Overdue');
    await user.click(screen.getByRole('button', { name: 'Snooze 15m' }));

    await waitFor(() => expect(screen.queryByText('Overdue')).not.toBeInTheDocument());
    expect(screen.getByText('Snoozed')).toBeInTheDocument();
  });

  it('does not offer Taken/Skip/Snooze once a dose is done', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T08:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => seedMedicineAndSchedule(repository),
    });

    await screen.findByText('Due now');
    await user.click(screen.getByRole('button', { name: 'Taken' }));
    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: 'Taken' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Snooze 15m' })).not.toBeInTheDocument();
  });
});
