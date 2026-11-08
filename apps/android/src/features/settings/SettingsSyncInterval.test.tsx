import { fireEvent, waitFor } from '@testing-library/react-native';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { AlarmProvider } from '../../alarms/AlarmProvider.js';
import { clearHouseholdSession, setHouseholdSession } from '../../identity/session.js';
import { SyncProvider } from '../../sync/SyncProvider.js';
import { getSyncIntervalMinutes } from '../../sync/syncInterval.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { SettingsScreen } from './SettingsScreen.js';

jest.mock('expo-background-task', () => ({
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  getStatusAsync: jest.fn().mockResolvedValue(2),
  registerTaskAsync: jest.fn().mockResolvedValue(undefined),
  unregisterTaskAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn().mockResolvedValue(false),
  getTaskOptionsAsync: jest.fn().mockResolvedValue(null),
}));

/**
 * The Settings "Background sync" card: choosing a preset persists it per device and — through the
 * connected `SyncProvider` — reschedules the background task at once, not at the next app start.
 */
function renderSettings(dbName: string) {
  return renderWithRepository(
    <SyncProvider>
      <AlarmProvider>
        <SettingsScreen />
      </AlarmProvider>
    </SyncProvider>,
    { dbName },
  );
}

describe('Settings — background sync interval', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is hidden on a device that belongs to no household', async () => {
    await clearHouseholdSession();
    const { findByText, queryByText } = renderSettings('settings-interval-hidden.db');

    await findByText('Settings');
    expect(queryByText('Background sync')).toBeNull();
  });

  it('shows 15 minutes selected by default, and applies a new choice immediately', async () => {
    await setHouseholdSession({
      deviceToken: 'tok-1',
      householdId: 'h1',
      userId: 'u1',
      deviceId: 'd1',
    });
    const { findByText, getByText } = renderSettings('settings-interval.db');

    await findByText('Background sync');
    await waitFor(() =>
      expect(BackgroundTask.registerTaskAsync).toHaveBeenCalledWith('MedGuardBackgroundSync', {
        minimumInterval: 15,
      }),
    );

    fireEvent.press(getByText('Once a day'));

    await waitFor(() => expect(getSyncIntervalMinutes()).resolves.toBe(1440));
    await waitFor(() =>
      expect(BackgroundTask.registerTaskAsync).toHaveBeenCalledWith('MedGuardBackgroundSync', {
        minimumInterval: 1440,
      }),
    );
    await findByText('Background sync set to once a day.');
  });

  it('Off stops background sync without touching foreground syncing', async () => {
    await setHouseholdSession({
      deviceToken: 'tok-1',
      householdId: 'h1',
      userId: 'u1',
      deviceId: 'd1',
    });
    (TaskManager.isTaskRegisteredAsync as jest.Mock).mockResolvedValue(true);
    (TaskManager.getTaskOptionsAsync as jest.Mock).mockResolvedValue({ minimumInterval: 15 });
    const { findByText, getByText } = renderSettings('settings-interval-off.db');

    await findByText('Background sync');
    fireEvent.press(getByText('Off'));

    await waitFor(() =>
      expect(BackgroundTask.unregisterTaskAsync).toHaveBeenCalledWith('MedGuardBackgroundSync'),
    );
    await findByText('Background sync is off.');
  });
});
