import { fireEvent, waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import type { Medicine, Schedule } from '@medguard/shared';
import { AlarmProvider } from '../../alarms/AlarmProvider.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import {
  readSnoozes,
  seedHouseholdSettings,
  seedMedicine,
  seedScheduleFor,
  seedSnooze,
} from '../../testUtils/seedAlarmData.js';
import * as MedGuardAlarms from '../../../modules/medguard-alarms/src';

// Mapped to `testUtils/mockMedguardAlarms.ts` by jest.config.js, so every export is a jest.Mock
// at runtime — the static type is the real module's, which knows nothing about that.
const stopChime = MedGuardAlarms.stopChime as unknown as jest.Mock;
import { TodayView } from './TodayView.js';

const NOW = '2026-06-15T12:00:00.000Z'; // 15:00 Jerusalem
const OCCURRENCE = 'schedule-1:2026-06-15T12:00:00.000Z';

function makeMedicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'medicine-1',
    patientId: 'patient-1',
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    updatedAt: NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    medicineId: 'medicine-1',
    patientId: 'patient-1',
    frequencyType: 'daily',
    timesOfDay: ['15:00'],
    dosageQuantity: 1,
    startDate: '2026-01-01',
    active: true,
    updatedAt: NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function renderTodayView(dbName: string) {
  return renderWithRepository(
    <AlarmProvider>
      <TodayView />
    </AlarmProvider>,
    { clock: fixedClock(NOW), dbName },
  );
}

// AlarmProvider now mounts alongside every TodayView in this file and runs its own
// reconcile()/applyPendingActions() chain — several more store transactions than TodayView's own
// queries, all serialized through the same SQLite test-double queue (ExpoSqliteDriver's queue on
// a real device; the ExpoSqliteDriver test double here). @testing-library's default 1000ms
// waitFor timeout was tuned before that extra chain existed and is tight enough to flake on a
// slower CI runner even though nothing is actually wrong — give every wait in this file room.
const WAIT_OPTIONS = { timeout: 5000 };

describe('TodayView', () => {
  it('renders and shows the empty state with nothing scheduled', async () => {
    // TodayView's Snooze button reads through useAlarmHealth(), which needs an AlarmProvider
    // ancestor — the same requirement DiagnosticsScreen.smoke.test.tsx has for SyncProvider.
    const { getByText, queryByText } = renderTodayView('today-view-smoke.db');

    await waitFor(() => expect(queryByText('Today')).toBeTruthy(), WAIT_OPTIONS);
    expect(getByText('Nothing scheduled today.')).toBeTruthy();
  });

  it('snoozes at the household’s configured length and persists it, so it survives a remount (AD5)', async () => {
    const dbName = 'today-view-snooze-persist.db';
    await seedHouseholdSettings(dbName, { snoozeMinutes: 20 });
    await seedMedicine(dbName, makeMedicine());
    await seedScheduleFor(dbName, makeSchedule());

    const { getByText } = renderTodayView(dbName);

    await waitFor(() => expect(getByText('Snooze 20m')).toBeTruthy(), WAIT_OPTIONS);
    fireEvent.press(getByText('Snooze 20m'));

    await waitFor(async () => {
      const stored = await readSnoozes(dbName, OCCURRENCE);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ minutes: 20, count: 1 });
    }, WAIT_OPTIONS);

    // A reload no longer clears it — the whole point of AD5. Re-render fresh against the same
    // database and confirm the dose still reads as snoozed rather than back to due-now.
    const second = renderTodayView(dbName);
    await waitFor(() => expect(second.getByText('Snoozed')).toBeTruthy(), WAIT_OPTIONS);
  });

  /**
   * Marking the dose is one of the alert's stop conditions, and it used not to work: cancelling
   * the alarm only unschedules a *future* one, so a caregiver could tap Taken while the phone was
   * still ringing and keep hearing it for the rest of the chime.
   */
  it('silences a ringing alert when the dose is marked taken', async () => {
    const dbName = 'today-view-taken-silences.db';
    await seedHouseholdSettings(dbName, { snoozeMinutes: 20 });
    await seedMedicine(dbName, makeMedicine());
    await seedScheduleFor(dbName, makeSchedule());
    stopChime.mockClear();

    const { getByText } = renderTodayView(dbName);

    await waitFor(() => expect(getByText('Taken')).toBeTruthy(), WAIT_OPTIONS);
    fireEvent.press(getByText('Taken'));

    await waitFor(() => expect(stopChime).toHaveBeenCalledWith(OCCURRENCE), WAIT_OPTIONS);
  });

  it('silences a ringing alert when the dose is skipped', async () => {
    const dbName = 'today-view-skip-silences.db';
    await seedHouseholdSettings(dbName, { snoozeMinutes: 20 });
    await seedMedicine(dbName, makeMedicine());
    await seedScheduleFor(dbName, makeSchedule());
    stopChime.mockClear();

    const { getByText } = renderTodayView(dbName);

    await waitFor(() => expect(getByText('Skip')).toBeTruthy(), WAIT_OPTIONS);
    fireEvent.press(getByText('Skip'));

    await waitFor(() => expect(stopChime).toHaveBeenCalledWith(OCCURRENCE), WAIT_OPTIONS);
  });

  it('bounds at three snoozes: the fourth is refused and the UI shows the count, not a button', async () => {
    // Domain-level enforcement of the bound (numbering, refusal at the cap) is already exhaustively
    // covered in AlarmEngine.test.ts; this proves TodayView actually reflects that state rather
    // than offering a button the engine would just refuse. Three already-expired snoozes leave
    // the dose overdue and out of snoozes — exactly AlarmEngine's "leaves the dose overdue and
    // still ringing" case, from the UI's point of view.
    const dbName = 'today-view-snooze-bound.db';
    await seedHouseholdSettings(dbName, { snoozeMinutes: 20 });
    await seedMedicine(dbName, makeMedicine());
    await seedScheduleFor(dbName, makeSchedule());
    for (const [index, createdAt] of [
      '2026-06-15T09:00:00.000Z',
      '2026-06-15T09:30:00.000Z',
      '2026-06-15T10:00:00.000Z',
    ].entries()) {
      await seedSnooze(dbName, {
        id: `snooze-${index + 1}`,
        occurrenceId: OCCURRENCE,
        minutes: 20,
        count: index + 1,
        createdAt,
        createdByUserId: 'mom',
        createdByDeviceId: 'device-1',
        syncStatus: 'synced',
      });
    }

    const { getByText, queryByText } = renderTodayView(dbName);

    await waitFor(() => expect(getByText('Snoozed 3/3')).toBeTruthy(), WAIT_OPTIONS);
    expect(queryByText('Snooze 20m')).toBeNull();
    // Every prior snooze's deadline (latest: 10:20) has passed by NOW, so the dose is back to
    // its own due time (12:00, exactly NOW) rather than staying parked in the snoozed bucket —
    // fail closed, still asking to be acted on, not silence.
    expect(getByText('Due now')).toBeTruthy();
  });
});
