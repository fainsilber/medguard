import { render, waitFor } from '@testing-library/react-native';
import { RepositoryProvider } from '../../app/RepositoryContext.js';
import { SyncProvider } from '../../sync/SyncProvider.js';
import { DiagnosticsScreen } from './DiagnosticsScreen.js';

/**
 * Confirms the Diagnostics screen — which absorbed Sprint A0's SpikeScreen content plus sync
 * status and the app log — renders against a real (in-memory-for-tests) repository and sync
 * provider without throwing. Not screen-specific coverage of every row, just the wiring.
 */
describe('DiagnosticsScreen', () => {
  it('renders once the repository has finished initializing', async () => {
    const { getByText, queryByText } = render(
      <RepositoryProvider userId="tester" dbName="diagnostics-smoke.db">
        <SyncProvider>
          <DiagnosticsScreen />
        </SyncProvider>
      </RepositoryProvider>,
    );

    await waitFor(() => {
      expect(queryByText('Diagnostics')).toBeTruthy();
    });

    expect(getByText('AD1 — Hermes ICU')).toBeTruthy();
    expect(getByText('Sync status')).toBeTruthy();
    expect(getByText('App log')).toBeTruthy();
  });
});
