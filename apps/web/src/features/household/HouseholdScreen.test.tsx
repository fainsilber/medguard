import 'fake-indexeddb/auto';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setHouseholdSession } from '../../api/session.js';
import { HouseholdScreen } from './HouseholdScreen.js';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function connect(householdName = 'The Cohens') {
  setHouseholdSession({
    deviceToken: 'tok-1',
    householdId: 'h1',
    userId: 'u1',
    deviceId: 'd1',
    householdName,
  });
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('HouseholdScreen', () => {
  it('explains that an unconnected device still works on its own', () => {
    render(<HouseholdScreen />);

    expect(screen.getByText(/isn’t connected to a household/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Invite another caregiver' })).not.toBeInTheDocument();
  });

  it('names the household this device is connected to', () => {
    connect();
    render(<HouseholdScreen />);

    expect(screen.getByText(/Connected to The Cohens/)).toBeInTheDocument();
  });

  it('shows a join code with its expiry and single-use warning', async () => {
    const user = userEvent.setup();
    connect();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({ code: '482913', expiresAt: '2026-08-03T10:15:00.000Z', expiresInSeconds: 900 }, 201),
      ),
    );
    render(<HouseholdScreen />);

    await user.click(screen.getByRole('button', { name: 'Invite another caregiver' }));

    expect(await screen.findByText('482913')).toBeInTheDocument();
    expect(screen.getByText(/within 15 minutes/)).toBeInTheDocument();
    expect(screen.getByText(/works once/)).toBeInTheDocument();
  });

  it('sends the device token so the code lands in this household', async () => {
    const user = userEvent.setup();
    connect();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ code: '482913', expiresAt: 'x', expiresInSeconds: 900 }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<HouseholdScreen />);

    await user.click(screen.getByRole('button', { name: 'Invite another caregiver' }));
    await screen.findByText('482913');

    const init = fetchMock.mock.calls[0]![1];
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer tok-1' });
  });

  it('dismisses the code once it has been read out', async () => {
    const user = userEvent.setup();
    connect();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ code: '482913', expiresAt: 'x', expiresInSeconds: 900 }, 201)),
    );
    render(<HouseholdScreen />);

    await user.click(screen.getByRole('button', { name: 'Invite another caregiver' }));
    await screen.findByText('482913');
    await user.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryByText('482913')).not.toBeInTheDocument();
  });

  it('reports a failure to issue a code rather than showing a blank box', async () => {
    const user = userEvent.setup();
    connect();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    render(<HouseholdScreen />);

    await user.click(screen.getByRole('button', { name: 'Invite another caregiver' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach the server/);
  });
});
