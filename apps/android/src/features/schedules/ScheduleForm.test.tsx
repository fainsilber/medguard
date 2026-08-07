import { fireEvent, waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import type { Schedule } from '@medguard/shared';
import { readSchedules, seedSchedule } from '../../testUtils/readSchedules.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { ScheduleForm } from './ScheduleForm.js';

/**
 * The core "never rewrite history" invariant: editing an existing schedule must close it and
 * create a new version (`repository.reviseSchedule`), never mutate it in place, while a brand-new
 * schedule must call `repository.saveSchedule(..., 'CREATE')`. Verified against real repository
 * state (via `schedulesForMedicine`), not by inspecting which internal branch ran.
 */

const NOW = '2026-06-15T12:00:00.000Z';

function makeExisting(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    medicineId: 'medicine-1',
    patientId: 'patient-1',
    frequencyType: 'daily',
    timesOfDay: ['08:00'],
    dosageQuantity: 1,
    startDate: '2026-01-01',
    active: true,
    updatedAt: NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('ScheduleForm — create vs. revise branching', () => {
  it('a brand-new schedule (no `existing`) calls saveSchedule(..., CREATE) — exactly one live schedule', async () => {
    const dbName = 'schedule-form-create.db';
    const { getByText, getByPlaceholderText } = renderWithRepository(
      <ScheduleForm medicineId="medicine-1" today="2026-06-15" onDone={jest.fn()} onCancel={jest.fn()} />,
      { clock: fixedClock(NOW), dbName },
    );

    await waitFor(() => expect(getByText('New schedule')).toBeTruthy());
    fireEvent.changeText(getByPlaceholderText('HH:MM'), '08:00');
    fireEvent.press(getByText('Save'));

    await waitFor(async () => {
      const schedules = await readSchedules(dbName, 'medicine-1');
      expect(schedules).toHaveLength(1);
    });

    const schedules = await readSchedules(dbName, 'medicine-1');
    expect(schedules[0]?.active).toBe(true);
    expect(schedules[0]?.startDate).toBe('2026-06-15');
    expect(schedules[0]?.supersedesId).toBeUndefined();
  });

  it('editing an existing schedule calls reviseSchedule — closes the old version, creates a new one', async () => {
    const dbName = 'schedule-form-revise.db';
    await seedSchedule(dbName, makeExisting());

    const onDone = jest.fn();
    const { getByText, getByDisplayValue } = renderWithRepository(
      <ScheduleForm
        medicineId="medicine-1"
        existing={makeExisting()}
        today="2026-06-15"
        onDone={onDone}
        onCancel={jest.fn()}
      />,
      { clock: fixedClock(NOW), dbName },
    );

    await waitFor(() => expect(getByText('Change this schedule')).toBeTruthy());
    // Change the dose quantity so the revision is distinguishable from the original.
    fireEvent.changeText(getByDisplayValue('1'), '2');
    fireEvent.press(getByText('Save'));

    await waitFor(() => expect(onDone).toHaveBeenCalled());

    const schedules = await readSchedules(dbName, 'medicine-1');
    expect(schedules).toHaveLength(2);

    const closed = schedules.find((s) => s.id === 'schedule-1');
    const created = schedules.find((s) => s.id !== 'schedule-1');

    // The original is never mutated into the new values — it's closed, not edited.
    expect(closed?.active).toBe(false);
    expect(closed?.dosageQuantity).toBe(1);
    expect(closed?.endDate).toBeDefined();

    expect(created?.active).toBe(true);
    expect(created?.dosageQuantity).toBe(2);
    expect(created?.supersedesId).toBe('schedule-1');
  });

  it('rejects an invalid time-of-day instead of saving', async () => {
    const dbName = 'schedule-form-invalid-time.db';
    const { getByText, getByPlaceholderText, queryByText } = renderWithRepository(
      <ScheduleForm medicineId="medicine-1" today="2026-06-15" onDone={jest.fn()} onCancel={jest.fn()} />,
      { clock: fixedClock(NOW), dbName },
    );

    await waitFor(() => expect(getByText('New schedule')).toBeTruthy());
    fireEvent.changeText(getByPlaceholderText('HH:MM'), '25:99');
    fireEvent.press(getByText('Save'));

    await waitFor(() => expect(queryByText(/Enter each time of day as HH:MM/)).toBeTruthy());

    expect(await readSchedules(dbName, 'medicine-1')).toHaveLength(0);
  });
});
