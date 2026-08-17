import { waitFor } from '@testing-library/react-native';
import { AlarmProvider } from '../../alarms/AlarmProvider.js';
import { SyncProvider } from '../../sync/SyncProvider.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { SettingsScreen } from './SettingsScreen.js';

/**
 * Confirms the Settings screen — which absorbed Sprint A0's SpikeScreen content plus sync
 * status and the app log — renders against a real (in-memory-for-tests) repository and sync
 * provider without throwing. Not screen-specific coverage of every row, just the wiring.
 *
 * This test is also the regression check for the `NotifyingStore`/`useLiveQuery` infinite-loop
 * bug it originally caught: a `useLiveQuery` that reads a table it also watches used to re-fire
 * its own subscription on every read (any query is itself a transaction, and the old
 * `NotifyingStore` notified on every transaction, not just writes), spinning a CPU core to 100%
 * until OOM. Fixed in `packages/store/src/notifyingStore.ts` — only a transaction that actually
 * writes now notifies.
 *
 * Wrapped in `AlarmProvider` too, matching `App.tsx`'s real nesting (just inside `SyncProvider`):
 * `SettingsScreen` renders `AlarmSetupChecklist`, which reads `useAlarmHealth()` and throws
 * outside a provider.
 */
describe('SettingsScreen', () => {
  it('renders once the repository has finished initializing', async () => {
    const { getByText, queryByText } = renderWithRepository(
      <SyncProvider>
        <AlarmProvider>
          <SettingsScreen />
        </AlarmProvider>
      </SyncProvider>,
      { dbName: 'settings-smoke.db' },
    );

    await waitFor(() => {
      expect(queryByText('Settings')).toBeTruthy();
    });

    expect(getByText('Build')).toBeTruthy();
    expect(getByText('AD1 — Hermes ICU')).toBeTruthy();
    expect(getByText('Sync status')).toBeTruthy();
    expect(getByText('App log')).toBeTruthy();
  });
});
