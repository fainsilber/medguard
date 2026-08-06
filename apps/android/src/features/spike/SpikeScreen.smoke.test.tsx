import { render } from '@testing-library/react-native';
import { SpikeScreen } from './SpikeScreen.js';

/**
 * Confirms the Jest + jest-expo + @testing-library/react-native toolchain (added Sprint A2) can
 * actually render a real screen against the real `medguard-alarms` native module mocks — a
 * one-off wiring check, not screen-specific coverage.
 */
describe('Jest/RTL-native wiring smoke test', () => {
  it('renders the A0 spike screen without throwing', () => {
    const { getByText } = render(<SpikeScreen />);
    expect(getByText('MedGuard — A0 spike')).toBeTruthy();
  });
});
