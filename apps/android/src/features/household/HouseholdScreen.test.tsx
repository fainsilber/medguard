import { waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import { clearHouseholdSession, setHouseholdSession } from '../../identity/session.js';
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

  describe('privacy policy link', () => {
    afterEach(async () => {
      jest.restoreAllMocks();
      await clearHouseholdSession();
    });

    it('is on the Household tab when the device is on its own', async () => {
      const { getByRole, queryByText } = renderWithRepository(<HouseholdScreen />, {
        clock: fixedClock('2026-06-15T12:00:00.000Z'),
        dbName: 'household-screen-policy-standalone.db',
      });

      await waitFor(() => expect(queryByText('Start a new household')).toBeTruthy());
      expect(getByRole('link', { name: 'Privacy policy' })).toBeTruthy();
    });

    it('is on the Household tab next to the delete controls once connected', async () => {
      await setHouseholdSession({
        deviceToken: 'token',
        householdId: 'household-1',
        userId: 'user-1',
        deviceId: 'device-1',
        householdName: 'Test',
      });
      jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ devices: [] }),
      } as Response);

      const { getByRole, queryByText } = renderWithRepository(<HouseholdScreen />, {
        clock: fixedClock('2026-06-15T12:00:00.000Z'),
        dbName: 'household-screen-policy-connected.db',
      });

      await waitFor(() => expect(queryByText('Delete this household')).toBeTruthy());
      expect(getByRole('link', { name: 'Privacy policy' })).toBeTruthy();
    });
  });
});
