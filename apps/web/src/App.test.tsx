import 'fake-indexeddb/auto';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

// The probe screen fetches the VAPID key and the server log on mount. Stub fetch so this stays a
// fast, network-free render test rather than attempting a real connection to an API that isn't
// running under vitest.
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('App', () => {
  it('asks who is using the device before showing anything else', () => {
    render(<App />);

    expect(screen.getByRole('heading', { name: 'MedGuard' })).toBeInTheDocument();
    expect(screen.getByText(/Who’s using this device/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('shows the tab shell with Today active once a caregiver identifies themselves', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText('Your name'), 'Mom');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    const todayTab = within(nav).getByRole('button', { name: 'Today' });
    expect(todayTab).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByRole('heading', { name: 'Today' })).toBeInTheDocument();
  });

  it('reaches the Sprint 0 diagnostics probe via its tab', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }) as Response),
    );
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByLabelText('Your name'), 'Mom');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    const nav = await screen.findByRole('navigation', { name: 'Sections' });
    await user.click(within(nav).getByRole('button', { name: 'Diagnostics' }));

    await waitFor(() => expect(screen.getByText(/failed to load/)).toBeInTheDocument());
  });
});
