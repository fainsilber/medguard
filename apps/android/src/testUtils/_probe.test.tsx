jest.mock('expo-asset', () => ({}), { virtual: true });
import { render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { RepositoryProvider, useRepository } from '../app/RepositoryContext.js';

function Probe() {
  const repository = useRepository();
  return <Text testID="ok">ready:{typeof repository}</Text>;
}

describe('probe', () => {
  it('renders past loading', async () => {
    const { getByTestId } = render(
      <RepositoryProvider userId="probe" dbName="probe.db">
        <Probe />
      </RepositoryProvider>,
    );
    await waitFor(() => expect(getByTestId('ok')).toBeTruthy(), { timeout: 5000 });
  });
});
