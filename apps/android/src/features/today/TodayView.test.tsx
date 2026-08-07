import { waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { TodayView } from './TodayView.js';

describe('TodayView', () => {
  it('renders and shows the empty state with nothing scheduled', async () => {
    const { getByText, queryByText } = renderWithRepository(<TodayView />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      dbName: 'today-view-smoke.db',
    });

    await waitFor(() => expect(queryByText('Today')).toBeTruthy());
    expect(getByText('Nothing scheduled today.')).toBeTruthy();
  });
});
