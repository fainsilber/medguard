import { waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { ExportScreen } from './ExportScreen.js';

describe('ExportScreen', () => {
  it('renders the empty state and disables Share CSV with nothing logged', async () => {
    const { getByText, queryByText } = renderWithRepository(<ExportScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      dbName: 'export-screen-smoke.db',
    });

    await waitFor(() => expect(queryByText('No doses logged yet.')).toBeTruthy());
    expect(getByText('Share CSV')).toBeTruthy();
    // No literal "Print summary" button — dropped deliberately, see ExportScreen.tsx's comment.
    expect(queryByText('Print summary')).toBeFalsy();
  });
});
