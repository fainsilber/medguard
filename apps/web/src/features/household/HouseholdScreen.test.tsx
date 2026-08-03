import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import { setHouseholdSession } from '../../api/session.js';
import { getCaregiverName, setCaregiverName } from '../../identity/caregiverName.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
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

const OTHER_DEVICE = {
  id: 'd2',
  platform: 'iPhone',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastSeenAt: '2026-08-02T00:00:00.000Z',
  userId: 'u2',
  displayName: 'Dad',
  isThisDevice: false,
};

const SELF_DEVICE = {
  id: 'd1',
  platform: 'desktop',
  createdAt: '2026-08-01T00:00:00.000Z',
  lastSeenAt: '2026-08-02T00:00:00.000Z',
  userId: 'u1',
  displayName: 'Mom',
  isThisDevice: true,
};

/** Routes fetch by URL so a single mock can serve every endpoint the screen touches. */
function stubFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      for (const [pattern, handler] of Object.entries(overrides)) {
        if (url.includes(pattern)) return handler();
      }
      if (url.includes('/api/v1/devices')) {
        return jsonResponse({ devices: [SELF_DEVICE, OTHER_DEVICE] });
      }
      return jsonResponse({ error: 'not_found' }, 404);
    }),
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderConnected() {
  connect();
  stubFetch();
  await renderWithRepository(<HouseholdScreen />, { clock: fixedClock('2026-08-03T12:00:00.000Z') });
  await screen.findByText((_, el) => el?.textContent === 'Mom (this device)');
}

describe('HouseholdScreen — disconnected', () => {
  it('explains that an unconnected device still works on its own', async () => {
    await renderWithRepository(<HouseholdScreen />, { clock: fixedClock('2026-08-03T12:00:00.000Z') });

    expect(screen.getByText(/isn’t connected to a household/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start a new household' })).toBeInTheDocument();
  });

  it('does not offer to skip — the device is already using itself', async () => {
    await renderWithRepository(<HouseholdScreen />, { clock: fixedClock('2026-08-03T12:00:00.000Z') });

    expect(
      screen.queryByRole('button', { name: 'Use this device on its own for now' }),
    ).not.toBeInTheDocument();
  });

  it('pre-fills the join form with the existing caregiver name', async () => {
    const user = userEvent.setup();
    setCaregiverName('Mom');
    await renderWithRepository(<HouseholdScreen />, { clock: fixedClock('2026-08-03T12:00:00.000Z') });

    await user.click(screen.getByRole('button', { name: 'Join with a code' }));
    expect(screen.getByLabelText('Your name')).toHaveValue('Mom');
  });

  it('connects immediately after creating a household, with no reload', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          { deviceToken: 'new-tok', householdId: 'h2', userId: 'u9', deviceId: 'd9' },
          201,
        ),
      ),
    );
    await renderWithRepository(<HouseholdScreen />, { clock: fixedClock('2026-08-03T12:00:00.000Z') });

    await user.click(screen.getByRole('button', { name: 'Start a new household' }));
    await user.type(screen.getByLabelText('Household name'), 'The Cohens');
    await user.type(screen.getByLabelText('Your name'), 'Mom');
    await user.click(screen.getByRole('button', { name: 'Create household' }));

    expect(await screen.findByText(/Connected to The Cohens/)).toBeInTheDocument();
  });
});

describe('HouseholdScreen — invite', () => {
  it('names the household this device is connected to', async () => {
    await renderConnected();
    expect(screen.getByText(/Connected to The Cohens/)).toBeInTheDocument();
  });

  it('shows a join code with its expiry and single-use warning', async () => {
    const user = userEvent.setup();
    await renderConnected();
    stubFetch({ '/join-codes': () => jsonResponse({ code: '482913', expiresAt: 'x', expiresInSeconds: 900 }, 201) });

    await user.click(screen.getByRole('button', { name: 'Invite another caregiver' }));

    expect(await screen.findByText('482913')).toBeInTheDocument();
    expect(screen.getByText(/within 15 minutes/)).toBeInTheDocument();
  });
});

describe('HouseholdScreen — devices', () => {
  it('lists every device, labels this one, and offers no revoke button for it', async () => {
    await renderConnected();

    const selfRow = screen.getByText((_, el) => el?.textContent === 'Mom (this device)').closest('li')!;
    expect(selfRow.querySelector('button')).toBeNull();

    const otherRow = screen.getByText('Dad').closest('li')!;
    expect(otherRow.querySelector('button')).not.toBeNull();
  });

  it('revokes another device and removes it from the list on refresh', async () => {
    const user = userEvent.setup();
    await renderConnected();

    stubFetch({
      '/devices/d2': () => jsonResponse({ ok: true }),
      '/devices': () => jsonResponse({ devices: [SELF_DEVICE] }),
    });

    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(screen.queryByText('Dad')).not.toBeInTheDocument());
  });

  it('reports a failed revoke without removing the device', async () => {
    const user = userEvent.setup();
    await renderConnected();
    stubFetch({ '/devices/d2': () => jsonResponse({ error: 'not_found' }, 404) });

    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(await screen.findByText(/could not be found/)).toBeInTheDocument();
    expect(screen.getByText('Dad')).toBeInTheDocument();
  });
});

describe('HouseholdScreen — leave', () => {
  it('warns that local data will be cleared before leaving', async () => {
    const user = userEvent.setup();
    await renderConnected();

    await user.click(screen.getByRole('button', { name: 'Leave this household' }));

    expect(screen.getByText(/data on this device will be cleared/)).toBeInTheDocument();
    expect(screen.getByText(/Other caregivers keep their own copies/)).toBeInTheDocument();
  });

  it('clears the session and local data, returning to the disconnected view', async () => {
    const user = userEvent.setup();
    await renderConnected();
    stubFetch({ '/leave': () => jsonResponse({ ok: true }) });

    await user.click(screen.getByRole('button', { name: 'Leave this household' }));
    await user.click(screen.getByRole('button', { name: 'Leave household' }));

    expect(await screen.findByText(/isn’t connected to a household/)).toBeInTheDocument();
  });

  it('can be cancelled without leaving', async () => {
    const user = userEvent.setup();
    await renderConnected();

    await user.click(screen.getByRole('button', { name: 'Leave this household' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText(/Connected to The Cohens/)).toBeInTheDocument();
    expect(screen.queryByText(/data on this device will be cleared/)).not.toBeInTheDocument();
  });

  it('reports a failed leave without clearing local session', async () => {
    const user = userEvent.setup();
    await renderConnected();
    stubFetch({ '/leave': () => jsonResponse({ error: 'unauthorized' }, 401) });

    await user.click(screen.getByRole('button', { name: 'Leave this household' }));
    await user.click(screen.getByRole('button', { name: 'Leave household' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer signed in/);
    expect(screen.getByText(/Connected to The Cohens/)).toBeInTheDocument();
  });
});

describe('HouseholdScreen — delete household', () => {
  it('keeps the confirm button disabled until DELETE is typed exactly', async () => {
    const user = userEvent.setup();
    await renderConnected();

    await user.click(screen.getByRole('button', { name: 'Delete this household' }));
    const confirmButton = screen.getByRole('button', { name: 'Delete household' });
    expect(confirmButton).toBeDisabled();

    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'delete');
    expect(confirmButton).toBeDisabled();

    await user.clear(screen.getByLabelText('Type DELETE to confirm'));
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    expect(confirmButton).toBeEnabled();
  });

  it('warns that deletion affects every caregiver, not just this device', async () => {
    const user = userEvent.setup();
    await renderConnected();

    await user.click(screen.getByRole('button', { name: 'Delete this household' }));
    expect(screen.getByText(/for every caregiver in it/)).toBeInTheDocument();
  });

  it('deletes the household and returns to the disconnected view', async () => {
    const user = userEvent.setup();
    await renderConnected();
    stubFetch({ '/households': () => jsonResponse({ ok: true }) });

    await user.click(screen.getByRole('button', { name: 'Delete this household' }));
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await user.click(screen.getByRole('button', { name: 'Delete household' }));

    expect(await screen.findByText(/isn’t connected to a household/)).toBeInTheDocument();
  });

  it('can be cancelled, clearing the typed phrase', async () => {
    const user = userEvent.setup();
    await renderConnected();

    await user.click(screen.getByRole('button', { name: 'Delete this household' }));
    await user.type(screen.getByLabelText('Type DELETE to confirm'), 'DELETE');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByLabelText('Type DELETE to confirm')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete this household' }));
    expect(screen.getByLabelText('Type DELETE to confirm')).toHaveValue('');
  });
});

describe('HouseholdScreen — switching households', () => {
  it('lets a caregiver join a different household right after leaving, keeping their name', async () => {
    const user = userEvent.setup();
    setCaregiverName('Mom');
    await renderConnected();
    stubFetch({ '/leave': () => jsonResponse({ ok: true }) });

    await user.click(screen.getByRole('button', { name: 'Leave this household' }));
    await user.click(screen.getByRole('button', { name: 'Leave household' }));
    await screen.findByText(/isn’t connected to a household/);

    stubFetch({
      '/join-codes/redeem': () =>
        jsonResponse(
          { deviceToken: 'tok-2', householdId: 'h3', householdName: 'The Bakers', userId: 'u3', deviceId: 'd3' },
          201,
        ),
    });

    await user.click(screen.getByRole('button', { name: 'Join with a code' }));
    expect(screen.getByLabelText('Your name')).toHaveValue('Mom');
    await user.type(screen.getByLabelText('Join code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Join household' }));

    expect(await screen.findByText(/Connected to The Bakers/)).toBeInTheDocument();
    expect(getCaregiverName()).toBe('Mom');
  });
});
