import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';

// Mounting now renders the capability probe, which fetches the VAPID key and the server log on
// mount. Stub fetch so this stays a fast, network-free render test rather than attempting a
// real connection to an API that isn't running under vitest.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('renders the app shell', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' }) as Response),
    );

    render(<App />);

    expect(screen.getByRole('heading', { name: 'MedGuard' })).toBeInTheDocument();
    // Lets the mount-time fetch/IndexedDB effects settle so no act() warning leaks into other tests.
    await waitFor(() => expect(screen.getByText(/failed to load/)).toBeInTheDocument());
  });
});
