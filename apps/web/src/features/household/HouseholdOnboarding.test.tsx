import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHouseholdSession } from '../../api/session.js';
import { getCaregiverName } from '../../identity/caregiverName.js';
import { HouseholdOnboarding } from './HouseholdOnboarding.js';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderOnboarding(overrides: { onDone?: () => void; onSkip?: () => void } = {}) {
  const onDone = overrides.onDone ?? vi.fn();
  const onSkip = overrides.onSkip ?? vi.fn();
  render(<HouseholdOnboarding onDone={onDone} onSkip={onSkip} />);
  return { onDone, onSkip };
}

describe('HouseholdOnboarding', () => {
  it('offers all three paths, including carrying on alone', () => {
    renderOnboarding();

    expect(screen.getByRole('button', { name: 'Start a new household' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join with a code' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Use this device on its own for now' }),
    ).toBeInTheDocument();
  });

  it('lets a caregiver skip — a device with no signal must never be locked out', async () => {
    const user = userEvent.setup();
    const { onSkip } = renderOnboarding();

    await user.click(screen.getByRole('button', { name: 'Use this device on its own for now' }));

    expect(onSkip).toHaveBeenCalledOnce();
    expect(getHouseholdSession()).toBeNull();
  });

  it('creates a household and stores the token and caregiver name', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' },
          201,
        ),
      ),
    );
    const { onDone } = renderOnboarding();

    await user.click(screen.getByRole('button', { name: 'Start a new household' }));
    await user.type(screen.getByLabelText('Household name'), 'The Cohens');
    await user.type(screen.getByLabelText('Your name'), 'Mom');
    await user.click(screen.getByRole('button', { name: 'Create household' }));

    expect(onDone).toHaveBeenCalledOnce();
    expect(getHouseholdSession()).toMatchObject({ deviceToken: 'tok-1', householdId: 'h1' });
    expect(getCaregiverName()).toBe('Mom');
  });

  it('joins with a code and stores the returned token', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ deviceToken: 'tok-2', householdId: 'h1', userId: 'u2', deviceId: 'd2' }, 201),
      ),
    );
    const { onDone } = renderOnboarding();

    await user.click(screen.getByRole('button', { name: 'Join with a code' }));
    await user.type(screen.getByLabelText('Join code'), '123456');
    await user.type(screen.getByLabelText('Your name'), 'Dad');
    await user.click(screen.getByRole('button', { name: 'Join household' }));

    expect(onDone).toHaveBeenCalledOnce();
    expect(getHouseholdSession()).toMatchObject({ deviceToken: 'tok-2', householdId: 'h1' });
  });

  it('strips non-digits from a typed join code, so a pasted code still works', async () => {
    const user = userEvent.setup();
    renderOnboarding();

    await user.click(screen.getByRole('button', { name: 'Join with a code' }));
    await user.type(screen.getByLabelText('Join code'), '12-34 56');

    expect(screen.getByLabelText('Join code')).toHaveValue('123456');
  });

  it('refuses a code that is not six digits without calling the server', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderOnboarding();

    await user.click(screen.getByRole('button', { name: 'Join with a code' }));
    await user.type(screen.getByLabelText('Join code'), '123');
    await user.type(screen.getByLabelText('Your name'), 'Dad');
    await user.click(screen.getByRole('button', { name: 'Join household' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('six digits');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('explains a rejected code in words a caregiver can act on', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'invalid_code' }, 400)));
    renderOnboarding();

    await user.click(screen.getByRole('button', { name: 'Join with a code' }));
    await user.type(screen.getByLabelText('Join code'), '123456');
    await user.type(screen.getByLabelText('Your name'), 'Dad');
    await user.click(screen.getByRole('button', { name: 'Join household' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/expired or already been used/);
    expect(getHouseholdSession()).toBeNull();
  });

  it('surfaces rate limiting rather than looking like a wrong code', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'too_many_attempts' }, 429)));
    renderOnboarding();

    await user.click(screen.getByRole('button', { name: 'Join with a code' }));
    await user.type(screen.getByLabelText('Join code'), '123456');
    await user.type(screen.getByLabelText('Your name'), 'Dad');
    await user.click(screen.getByRole('button', { name: 'Join household' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many attempts/);
  });

  it('reports an unreachable server without storing a half-made session', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    renderOnboarding();

    await user.click(screen.getByRole('button', { name: 'Start a new household' }));
    await user.type(screen.getByLabelText('Household name'), 'The Cohens');
    await user.type(screen.getByLabelText('Your name'), 'Mom');
    await user.click(screen.getByRole('button', { name: 'Create household' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach the server/);
    expect(getHouseholdSession()).toBeNull();
    expect(getCaregiverName()).toBeNull();
  });

  it('requires both fields before creating a household', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderOnboarding();

    await user.click(screen.getByRole('button', { name: 'Start a new household' }));
    await user.click(screen.getByRole('button', { name: 'Create household' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('can back out of either path', async () => {
    const user = userEvent.setup();
    renderOnboarding();

    await user.click(screen.getByRole('button', { name: 'Start a new household' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Join with a code' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Join with a code' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('button', { name: 'Start a new household' })).toBeInTheDocument();
  });
});
