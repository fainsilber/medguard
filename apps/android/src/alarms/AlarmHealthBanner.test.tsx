import { fireEvent, waitFor } from '@testing-library/react-native';
// Resolves to testUtils/mockMedguardAlarms.ts via jest.config.js's moduleNameMapper — the same
// module instance AlarmProvider/AlarmSetupChecklist import, so overriding it here is visible to
// the component under test. Every export there is already a `jest.fn()`, so overrides go
// straight on the export rather than through `jest.spyOn` — and are reset explicitly afterward,
// since a mock cleared instead of reset would resolve `undefined` and break every later test.
import * as MedGuardAlarms from '../../modules/medguard-alarms/src';
import { renderWithRepository } from '../testUtils/renderWithRepository.js';
import { seedLastSyncedAt } from '../testUtils/seedAlarmData.js';
import { AlarmHealthBanner } from './AlarmHealthBanner.js';
import { AlarmProvider } from './AlarmProvider.js';

afterEach(() => {
  (MedGuardAlarms.canScheduleExactAlarms as jest.Mock).mockResolvedValue(true);
  (MedGuardAlarms.isIgnoringBatteryOptimizations as jest.Mock).mockResolvedValue(true);
  (MedGuardAlarms.requestScheduleExactAlarm as jest.Mock).mockResolvedValue(undefined);
});

function renderBanner(dbName: string) {
  return renderWithRepository(
    <AlarmProvider>
      <AlarmHealthBanner />
    </AlarmProvider>,
    { dbName },
  );
}

describe('AlarmHealthBanner', () => {
  it('says nothing on a device with granted permissions, aside from being unsynced by default', async () => {
    // A fresh test database has never completed a sync pull (there is no SyncProvider in this
    // tree to run one), so the honest default is the staleness message — not silence, which
    // would be the wrong answer for a device that genuinely has no idea what "current" data is.
    const { queryByText, getByText } = renderBanner('alarm-banner-default.db');

    await waitFor(() => expect(getByText('MedGuard has not synced recently')).toBeTruthy());
    expect(queryByText('MedGuard alarms are off')).toBeNull();
  });

  it('reports a blocked device with the same wording the ongoing notification uses', async () => {
    (MedGuardAlarms.canScheduleExactAlarms as jest.Mock).mockResolvedValue(false);

    const { getByText } = renderBanner('alarm-banner-blocked.db');

    await waitFor(() => expect(getByText('MedGuard alarms are off')).toBeTruthy());
    expect(getByText(/Exact alarms are not permitted/)).toBeTruthy();
  });

  it('expands into the setup checklist and lets a caregiver grant the missing permission', async () => {
    (MedGuardAlarms.canScheduleExactAlarms as jest.Mock).mockResolvedValue(false);

    const { getByText } = renderBanner('alarm-banner-fix.db');

    await waitFor(() => expect(getByText('Fix this')).toBeTruthy());
    fireEvent.press(getByText('Fix this'));

    await waitFor(() => expect(getByText('Exact alarms')).toBeTruthy());
    fireEvent.press(getByText('Grant'));

    await waitFor(() => expect(MedGuardAlarms.requestScheduleExactAlarm).toHaveBeenCalled());
  });

  it('offers no fix action for a mere risk — there is nothing to grant programmatically (AD7)', async () => {
    // Staleness outranks a risk in describeAlarmStatus, so a device that has never synced would
    // otherwise mask the risk this test means to exercise — seed a fresh sync first, matching
    // renderWithRepository's default fixed clock so it reads as "just synced".
    const dbName = 'alarm-banner-risk.db';
    await seedLastSyncedAt(dbName, '2026-01-15T08:00:00.000Z');
    (MedGuardAlarms.isIgnoringBatteryOptimizations as jest.Mock).mockResolvedValue(false);

    const { getByText, queryByText } = renderBanner(dbName);

    await waitFor(() => expect(getByText('MedGuard alarms may be delayed')).toBeTruthy());
    expect(queryByText('Fix this')).toBeNull();
  });
});
