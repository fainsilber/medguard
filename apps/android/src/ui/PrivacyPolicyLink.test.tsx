import { Linking } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { PRIVACY_POLICY_URL } from '@medguard/shared';
import { PrivacyPolicyLink } from './PrivacyPolicyLink.js';

describe('PrivacyPolicyLink', () => {
  // `Linking.openURL` is already a jest.fn in jest-expo's preset, so `spyOn` returns that same
  // mock and its call history would otherwise carry over from one test to the next.
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('opens the published policy URL in the phone’s browser', () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    const { getByRole } = render(<PrivacyPolicyLink />);

    fireEvent.press(getByRole('link', { name: 'Privacy policy' }));

    expect(openURL).toHaveBeenCalledWith(PRIVACY_POLICY_URL);
  });

  it('is a public https address, since that is what the store listing has to link to', () => {
    expect(PRIVACY_POLICY_URL).toMatch(/^https:\/\//);
  });

  it('shows the address rather than doing nothing when no browser can open it', async () => {
    jest
      .spyOn(Linking, 'openURL')
      .mockRejectedValue(new Error('No Activity found to handle Intent'));
    const { getByRole, findByText, queryByText } = render(<PrivacyPolicyLink />);
    expect(queryByText(/Couldn.t open the link/)).toBeNull();

    fireEvent.press(getByRole('link', { name: 'Privacy policy' }));

    expect(
      await findByText(new RegExp(PRIVACY_POLICY_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
    ).toBeTruthy();
  });

  it('clears the failure message on the next attempt', async () => {
    const openURL = jest
      .spyOn(Linking, 'openURL')
      .mockRejectedValueOnce(new Error('No Activity found'))
      .mockResolvedValue(true);
    const { getByRole, findByText, queryByText } = render(<PrivacyPolicyLink />);

    fireEvent.press(getByRole('link', { name: 'Privacy policy' }));
    await findByText(/Couldn.t open the link/);

    fireEvent.press(getByRole('link', { name: 'Privacy policy' }));

    await waitFor(() => expect(queryByText(/Couldn.t open the link/)).toBeNull());
    expect(openURL).toHaveBeenCalledTimes(2);
  });
});
