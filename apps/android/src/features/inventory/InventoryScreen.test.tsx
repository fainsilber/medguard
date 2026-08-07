import { waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { InventoryScreen } from './InventoryScreen.js';

describe('InventoryScreen', () => {
  it('renders the empty state with no medicines set up', async () => {
    const { queryByText } = renderWithRepository(<InventoryScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      dbName: 'inventory-screen-smoke.db',
    });

    await waitFor(() => expect(queryByText('No medicines yet.')).toBeTruthy());
  });
});
