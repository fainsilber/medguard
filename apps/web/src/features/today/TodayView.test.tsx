import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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
    expect(screen.getByText(/Taken 08:00 by Mom/)).toBeInTheDocument();
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

  it('logs an on-time dose straight away, without asking when it was taken', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T08:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => seedMedicineAndSchedule(repository),
    });

    await screen.findByText('Due now');
    await user.click(screen.getByRole('button', { name: 'Taken' }));

    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument());
    expect(screen.queryByText('When was it actually taken?')).not.toBeInTheDocument();
  });

  it('asks when an overdue dose was taken, and can record it as given on time', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<TodayView />, {
      // An hour and a quarter after the 08:00 dose was due — the caregiver gave it on time but is
      // only acknowledging it now.
      clock: fixedClock('2026-06-15T09:15:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => seedMedicineAndSchedule(repository),
    });

    await screen.findByText('Overdue');
    await user.click(screen.getByRole('button', { name: 'Taken' }));

    expect(screen.getByText('When was it actually taken?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'On time — 08:00' }));

    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument());
    // Recorded at the time it was actually given, not the time the button was pressed.
    expect(screen.getByText(/Taken 08:00 by/)).toBeInTheDocument();
    expect(screen.queryByText(/not at the scheduled time/)).not.toBeInTheDocument();
  });

  it('can record an overdue dose as given just now, flagged as off-schedule', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T09:15:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => seedMedicineAndSchedule(repository),
    });

    await screen.findByText('Overdue');
    await user.click(screen.getByRole('button', { name: 'Taken' }));
    await user.click(screen.getByRole('button', { name: 'Just now — 09:15' }));

    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument());
    expect(screen.getByText(/Taken 09:15 by/)).toBeInTheDocument();
    expect(screen.getByText(/not at the scheduled time/)).toBeInTheDocument();
  });

  it('accepts a custom time for an overdue dose', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T09:15:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => seedMedicineAndSchedule(repository),
    });

    await screen.findByText('Overdue');
    await user.click(screen.getByRole('button', { name: 'Taken' }));
    await user.click(screen.getByRole('button', { name: 'Another time' }));

    fireEvent.change(screen.getByLabelText('Time taken'), { target: { value: '08:30' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('Done')).toBeInTheDocument());
    expect(screen.getByText(/Taken 08:30 by/)).toBeInTheDocument();
  });

  it('cancels out of the time prompt without logging anything', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T09:15:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => seedMedicineAndSchedule(repository),
    });

    await screen.findByText('Overdue');
    await user.click(screen.getByRole('button', { name: 'Taken' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('When was it actually taken?')).not.toBeInTheDocument();
    expect(screen.getByText('Overdue')).toBeInTheDocument();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
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
