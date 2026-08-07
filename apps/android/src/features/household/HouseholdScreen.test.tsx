import { waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { HouseholdScreen } from './HouseholdScreen.js';

describe('HouseholdScreen', () => {
  it('with no household session, shows the standalone explainer and onboarding', async () => {
    const { getByText, queryByText } = renderWithRepository(<HouseholdScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      dbName: 'household-screen-smoke.db',
    });

    await waitFor(() => expect(queryByText('Household')).toBeTruthy());
    expect(getByText(/isn.t connected to a household/)).toBeTruthy();
    expect(getByText('Start a new household')).toBeTruthy();
    expect(getByText('Join with a code')).toBeTruthy();
  });
});
