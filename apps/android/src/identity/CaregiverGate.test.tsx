import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { CaregiverGate } from './CaregiverGate.js';
import { clearCaregiverName, getCaregiverName, setCaregiverName } from './caregiverName.js';
import { clearHouseholdSession } from './session.js';

/**
 * RN port of `apps/web/src/identity/CaregiverGate.test.tsx`. `getCaregiverName()` and
 * `getHouseholdSession()` are async here (`expo-secure-store` has no synchronous read), so the
 * gate renders a brief loading state before it can decide which of the three views to show — a
 * real, deliberate deviation from web's synchronous first paint (the component's own doc
 * comment). Every test below waits past that loading state before asserting.
 */

beforeEach(async () => {
  await clearCaregiverName();
  await clearHouseholdSession();
});

afterEach(async () => {
  await clearCaregiverName();
  await clearHouseholdSession();
});

function renderGate() {
  return render(
    <CaregiverGate>
      <Text>App content</Text>
    </CaregiverGate>,
  );
}

async function chooseStandalone(findByText: (text: string) => Promise<unknown>) {
  fireEvent.press((await findByText('Use this device on its own for now')) as never);
}

describe('CaregiverGate', () => {
  it('offers a household before anything else on a brand-new device', async () => {
    const { findByText, queryByText } = renderGate();

    expect(await findByText('Start a new household')).toBeTruthy();
    expect(queryByText('Join with a code')).toBeTruthy();
    expect(queryByText('App content')).toBeFalsy();
  });

  it('lets a caregiver decline a household and carry on alone — offline must never be blocked', async () => {
    const { findByText, queryByText } = renderGate();
    await chooseStandalone(findByText);

    expect(await findByText('Your name')).toBeTruthy();
    expect(queryByText('App content')).toBeFalsy();
  });

  it('renders children directly when a name is already stored', async () => {
    await setCaregiverName('Mom');
    const { findByText, queryByText } = renderGate();

    expect(await findByText('App content')).toBeTruthy();
    expect(queryByText('Your name')).toBeFalsy();
  });

  it('stores the name and unlocks the app on submit', async () => {
    const { getByText, findByText, getByPlaceholderText } = renderGate();
    await chooseStandalone(findByText);

    fireEvent.changeText(getByPlaceholderText('e.g. Mom, Dad, Grandma'), 'Dad');
    fireEvent.press(getByText('Continue'));

    expect(await findByText('App content')).toBeTruthy();
    expect(await getCaregiverName()).toBe('Dad');
  });

  it('rejects a blank submission without unlocking the app', async () => {
    const { getByText, findByText, queryByText } = renderGate();
    await chooseStandalone(findByText);

    fireEvent.press(getByText('Continue'));

    await waitFor(() => expect(queryByText('Caregiver name cannot be blank')).toBeTruthy());
    expect(queryByText('App content')).toBeFalsy();
    expect(await getCaregiverName()).toBeNull();
  });

  it('clears the error once the caregiver starts typing again', async () => {
    const { getByText, findByText, getByPlaceholderText, queryByText } = renderGate();
    await chooseStandalone(findByText);

    fireEvent.press(getByText('Continue'));
    await waitFor(() => expect(queryByText('Caregiver name cannot be blank')).toBeTruthy());

    fireEvent.changeText(getByPlaceholderText('e.g. Mom, Dad, Grandma'), 'M');
    expect(queryByText('Caregiver name cannot be blank')).toBeFalsy();
  });
});
