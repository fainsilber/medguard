import { fireEvent, waitFor } from '@testing-library/react-native';
import type { Schedule } from '@medguard/shared';
import { readSchedules, seedSchedule } from '../../testUtils/readSchedules.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { ScheduleList } from './ScheduleList.js';

/**
 * RN port of `apps/web/src/features/schedules/ScheduleList.test.tsx`. Unlike web, this
 * `ScheduleList` doesn't swap `ScheduleForm` in place — "+ Add schedule"/"Change" call
 * `onAddSchedule`/`onEditSchedule` so a stack navigator can push it as its own screen (see the
 * component's own doc comment) — so this file covers the list/toggle/stop behavior `ScheduleList`
 * itself owns; the create-vs-revise branching those callbacks lead to is already proven directly
 * against `ScheduleForm` in `ScheduleForm.test.tsx`.
 */

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    medicineId: 'medicine-1',
    patientId: 'patient-1',
    frequencyType: 'daily',
    timesOfDay: ['08:00'],
    dosageQuantity: 1,
    startDate: '2026-01-01',
    active: true,
    updatedAt: '2026-06-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('ScheduleList', () => {
  it('shows no active schedule before one is created', async () => {
    const { findByText } = renderWithRepository(
      <ScheduleList medicineId="medicine-1" onAddSchedule={jest.fn()} onEditSchedule={jest.fn()} />,
      { dbName: 'schedule-list-empty.db' },
    );

    expect(await findByText('No active schedule.')).toBeTruthy();
  });

  it('shows an active schedule’s description and dose quantity', async () => {
    const dbName = 'schedule-list-active.db';
    await seedSchedule(dbName, makeSchedule());

    const { findByText } = renderWithRepository(
      <ScheduleList medicineId="medicine-1" onAddSchedule={jest.fn()} onEditSchedule={jest.fn()} />,
      { dbName },
    );

    expect(await findByText('Every day at 08:00 — 1')).toBeTruthy();
  });

  it('"+ Add schedule" calls onAddSchedule rather than rendering the form inline', async () => {
    const onAddSchedule = jest.fn();
    const { findByText } = renderWithRepository(
      <ScheduleList medicineId="medicine-1" onAddSchedule={onAddSchedule} onEditSchedule={jest.fn()} />,
      { dbName: 'schedule-list-add.db' },
    );

    fireEvent.press(await findByText('+ Add schedule'));

    expect(onAddSchedule).toHaveBeenCalledTimes(1);
  });

  it('"Change" calls onEditSchedule with the active schedule, not a mutated copy', async () => {
    const dbName = 'schedule-list-change.db';
    const schedule = makeSchedule();
    await seedSchedule(dbName, schedule);
    const onEditSchedule = jest.fn();

    const { findByText } = renderWithRepository(
      <ScheduleList medicineId="medicine-1" onAddSchedule={jest.fn()} onEditSchedule={onEditSchedule} />,
      { dbName },
    );
    await findByText('Every day at 08:00 — 1');

    fireEvent.press(await findByText('Change'));

    expect(onEditSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'schedule-1' }));
  });

  it('"Stop" closes the schedule through the repository, with no replacement created', async () => {
    const dbName = 'schedule-list-stop.db';
    await seedSchedule(dbName, makeSchedule());

    const { findByText } = renderWithRepository(
      <ScheduleList medicineId="medicine-1" onAddSchedule={jest.fn()} onEditSchedule={jest.fn()} />,
      { dbName },
    );
    await findByText('Every day at 08:00 — 1');

    fireEvent.press(await findByText('Stop'));

    await waitFor(async () => {
      expect(await findByText('No active schedule.')).toBeTruthy();
    });
    const schedules = await readSchedules(dbName, 'medicine-1');
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ id: 'schedule-1', active: false });
  });

  it('a closed schedule stays visible under "Past schedules", not hidden', async () => {
    const dbName = 'schedule-list-past.db';
    await seedSchedule(
      dbName,
      makeSchedule({ active: false, endDate: '2026-06-10', updatedAt: '2026-06-10T00:00:00.000Z' }),
    );

    const { findByText, queryByText } = renderWithRepository(
      <ScheduleList medicineId="medicine-1" onAddSchedule={jest.fn()} onEditSchedule={jest.fn()} />,
      { dbName },
    );

    await findByText('No active schedule.');
    const toggle = await findByText('Past schedules (1)');
    expect(queryByText(/Every day at 08:00 — 1 — ended/)).toBeFalsy();

    fireEvent.press(toggle);

    expect(await findByText(/Every day at 08:00 — 1 — ended 2026-06-10/)).toBeTruthy();
  });
});
