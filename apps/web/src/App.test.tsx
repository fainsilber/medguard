import 'fake-indexeddb/auto';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

// Nothing here should reach the network; the diagnostics screen only talks to the API when a
// button is pressed. Anything that slips through is stubbed so this stays a fast render test.
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

/**
 * A fresh device is offered a household first. These tests are about the app shell, so they take
 * the standalone path — which also keeps them free of any network dependency.
 */
async function signInStandalone(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Use this device on its own for now' }));
  await user.type(screen.getByLabelText('Your name'), 'Mom');
  await user.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('App', () => {
  it('offers a household, then asks who is using the device, before showing anything else', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole('heading', { name: 'MedGuard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start a new household' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Use this device on its own for now' }));

    expect(screen.getByText(/Who’s using this device/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('shows the tab shell with Today active once a caregiver identifies themselves', async () => {
    const user = userEvent.setup();
    render(<App />);

    await signInStandalone(user);

    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    const todayTab = within(nav).getByRole('button', { name: 'Today' });
    expect(todayTab).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
  });

  it('reaches Diagnostics via its tab, and shows which build is running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }) as Response),
    );
    const user = userEvent.setup();
    render(<App />);

    await signInStandalone(user);

    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    await user.click(within(nav).getByRole('button', { name: 'Diagnostics' }));

    // The build-identity line is the reason this screen survived the probe's removal: without it
    // there is no way to tell from inside the app which commit a device is running.
    await waitFor(() => expect(screen.getByText(/^v/)).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: /Dose alerts/ })).toBeInTheDocument();
  });
});
