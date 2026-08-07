import { waitFor } from '@testing-library/react-native';
import { SyncProvider } from '../../sync/SyncProvider.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { DiagnosticsScreen } from './DiagnosticsScreen.js';

/**
 * Confirms the Diagnostics screen — which absorbed Sprint A0's SpikeScreen content plus sync
 * status and the app log — renders against a real (in-memory-for-tests) repository and sync
 * provider without throwing. Not screen-specific coverage of every row, just the wiring.
 *
 * This test is also the regression check for the `NotifyingStore`/`useLiveQuery` infinite-loop
 * bug it originally caught: a `useLiveQuery` that reads a table it also watches used to re-fire
 * its own subscription on every read (any query is itself a transaction, and the old
 * `NotifyingStore` notified on every transaction, not just writes), spinning a CPU core to 100%
 * until OOM. Fixed in `packages/store/src/notifyingStore.ts` — only a transaction that actually
 * writes now notifies.
 */
describe('DiagnosticsScreen', () => {
  it('renders once the repository has finished initializing', async () => {
    const { getByText, queryByText } = renderWithRepository(
      <SyncProvider>
        <DiagnosticsScreen />
      </SyncProvider>,
      { dbName: 'diagnostics-smoke.db' },
    );

    await waitFor(() => {
      expect(queryByText('Diagnostics')).toBeTruthy();
    });

    expect(getByText('AD1 — Hermes ICU')).toBeTruthy();
    expect(getByText('Sync status')).toBeTruthy();
    expect(getByText('App log')).toBeTruthy();
  });
});
