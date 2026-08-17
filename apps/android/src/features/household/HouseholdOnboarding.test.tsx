import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { clearCaregiverName, getCaregiverName } from '../../identity/caregiverName.js';
import { clearHouseholdSession, getHouseholdSession } from '../../identity/session.js';
import { HouseholdOnboarding } from './HouseholdOnboarding.js';

/**
 * RN port of `apps/web/src/features/household/HouseholdOnboarding.test.tsx`. This screen touches
 * no repository, so `render` (not `renderWithRepository`) is enough — same as web's plain
 * `render`. The only real port difference: `finish()` is async here (`expo-secure-store` has no
 * synchronous write), so every assertion on `getHouseholdSession()`/`getCaregiverName()` awaits.
 * Also closes the one other gap this app has: `api/householdApi.ts` and `api/config.ts` are
 * otherwise unreached by any Jest test besides `SyncProvider.test.tsx`.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function stubFetch(impl: jest.Mock): void {
  global.fetch = impl as unknown as typeof fetch;
}

beforeEach(async () => {
  await clearCaregiverName();
  await clearHouseholdSession();
});

afterEach(async () => {
  await clearCaregiverName();
  await clearHouseholdSession();
  jest.restoreAllMocks();
});

function renderOnboarding(overrides: { onDone?: () => void; onSkip?: () => void } = {}) {
  const onDone = overrides.onDone ?? jest.fn();
  const onSkip = overrides.onSkip ?? jest.fn();
  const result = render(<HouseholdOnboarding onDone={onDone} onSkip={onSkip} />);
  return { ...result, onDone, onSkip };
}

describe('HouseholdOnboarding', () => {
  it('offers all three paths, including carrying on alone', () => {
    const { getByText } = renderOnboarding();

    expect(getByText('Start a new household')).toBeTruthy();
    expect(getByText('Join with a code')).toBeTruthy();
    expect(getByText('Use this device on its own for now')).toBeTruthy();
  });

  it('lets a caregiver skip — a device with no signal must never be locked out', async () => {
    const { getByText, onSkip } = renderOnboarding();

    fireEvent.press(getByText('Use this device on its own for now'));

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(await getHouseholdSession()).toBeNull();
  });

  it('creates a household and stores the token and caregiver name', async () => {
    stubFetch(
      jest.fn(async () =>
        jsonResponse({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' }, 201),
      ),
    );
    const { getByText, getByPlaceholderText, onDone } = renderOnboarding();

    fireEvent.press(getByText('Start a new household'));
    fireEvent.changeText(getByPlaceholderText('e.g. The Cohens'), 'The Cohens');
    fireEvent.changeText(getByPlaceholderText('e.g. Mom'), 'Mom');
    fireEvent.press(getByText('Create household'));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(await getHouseholdSession()).toMatchObject({ deviceToken: 'tok-1', householdId: 'h1' });
    expect(await getCaregiverName()).toBe('Mom');
  });

  it('joins with a code and stores the returned token', async () => {
    stubFetch(
      jest.fn(async () =>
        jsonResponse({ deviceToken: 'tok-2', householdId: 'h1', userId: 'u2', deviceId: 'd2' }, 201),
      ),
    );
    const { getByText, getByPlaceholderText, onDone } = renderOnboarding();

    fireEvent.press(getByText('Join with a code'));
    fireEvent.changeText(getByPlaceholderText('000000'), '123456');
    fireEvent.changeText(getByPlaceholderText('e.g. Dad'), 'Dad');
    fireEvent.press(getByText('Join household'));

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(await getHouseholdSession()).toMatchObject({ deviceToken: 'tok-2', householdId: 'h1' });
  });

  it('strips non-digits from a typed join code, so a pasted code still works', () => {
    const { getByText, getByPlaceholderText } = renderOnboarding();

    fireEvent.press(getByText('Join with a code'));
    fireEvent.changeText(getByPlaceholderText('000000'), '12-34 56');

    expect(getByPlaceholderText('000000').props.value).toBe('123456');
  });

  it('refuses a code that is not six digits without calling the server', async () => {
    const fetchMock = jest.fn();
    stubFetch(fetchMock);
    const { getByText, getByPlaceholderText, findByText } = renderOnboarding();

    fireEvent.press(getByText('Join with a code'));
    fireEvent.changeText(getByPlaceholderText('000000'), '123');
    fireEvent.changeText(getByPlaceholderText('e.g. Dad'), 'Dad');
    fireEvent.press(getByText('Join household'));

    expect(await findByText(/six digits/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains a rejected code in words a caregiver can act on', async () => {
    stubFetch(jest.fn(async () => jsonResponse({ error: 'invalid_code' }, 400)));
    const { getByText, getByPlaceholderText, findByText } = renderOnboarding();

    fireEvent.press(getByText('Join with a code'));
    fireEvent.changeText(getByPlaceholderText('000000'), '123456');
    fireEvent.changeText(getByPlaceholderText('e.g. Dad'), 'Dad');
    fireEvent.press(getByText('Join household'));

    expect(await findByText(/expired or already been used/)).toBeTruthy();
    expect(await getHouseholdSession()).toBeNull();
  });

  it('surfaces rate limiting rather than looking like a wrong code', async () => {
    stubFetch(jest.fn(async () => jsonResponse({ error: 'too_many_attempts' }, 429)));
    const { getByText, getByPlaceholderText, findByText } = renderOnboarding();

    fireEvent.press(getByText('Join with a code'));
    fireEvent.changeText(getByPlaceholderText('000000'), '123456');
    fireEvent.changeText(getByPlaceholderText('e.g. Dad'), 'Dad');
    fireEvent.press(getByText('Join household'));

    expect(await findByText(/Too many attempts/)).toBeTruthy();
  });

  it('reports an unreachable server without storing a half-made session', async () => {
    stubFetch(
      jest.fn(async () => {
        throw new Error('offline');
      }),
    );
    const { getByText, getByPlaceholderText, findByText } = renderOnboarding();

    fireEvent.press(getByText('Start a new household'));
    fireEvent.changeText(getByPlaceholderText('e.g. The Cohens'), 'The Cohens');
    fireEvent.changeText(getByPlaceholderText('e.g. Mom'), 'Mom');
    fireEvent.press(getByText('Create household'));

    expect(await findByText(/Could not reach the server/)).toBeTruthy();
    expect(await getHouseholdSession()).toBeNull();
    expect(await getCaregiverName()).toBeNull();
  });

  it('requires both fields before creating a household', async () => {
    const fetchMock = jest.fn();
    stubFetch(fetchMock);
    const { getByText, findByText } = renderOnboarding();

    fireEvent.press(getByText('Start a new household'));
    fireEvent.press(getByText('Create household'));

    expect(await findByText('Please fill in both fields.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('can back out of either path', () => {
    const { getByText } = renderOnboarding();

    fireEvent.press(getByText('Start a new household'));
    fireEvent.press(getByText('Back'));
    expect(getByText('Join with a code')).toBeTruthy();

    fireEvent.press(getByText('Join with a code'));
    fireEvent.press(getByText('Back'));
    expect(getByText('Start a new household')).toBeTruthy();
  });
});
