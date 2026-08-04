import 'fake-indexeddb/auto';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProbePage } from './ProbePage.js';
import { clearReceipts, saveReceipt } from './receiptStore.js';

const SERVER_LOG = {
  pending: 0,
  sent: [
    {
      burstIndex: 1,
      burstTotal: 1,
      dueAtIso: '2026-08-02T09:00:20.000Z',
      sentAtIso: '2026-08-02T09:00:20.100Z',
      latenessMs: 100,
      ok: true,
      status: 201,
    },
  ],
};

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/vapid-public-key')) {
        return { ok: true, status: 200, json: async () => ({ publicKey: 'BAbc123' }), text: async () => '' } as Response;
      }
      if (url.includes('/push-log/')) {
        return { ok: true, status: 200, json: async () => SERVER_LOG, text: async () => '' } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' } as Response;
    }),
  );
}

beforeEach(async () => {
  localStorage.clear();
  await clearReceipts();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await clearReceipts();
});

describe('ProbePage', () => {
  it('renders all six probe sections', async () => {
    stubFetch();
    render(<ProbePage />);

    expect(screen.getByRole('heading', { name: '1. Environment' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '2. Storage persistence' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '3. Background timer survival' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '4. Push delivery' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '5. App logs' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '6. Results' })).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText(/VAPID key: loaded/)).toBeInTheDocument());
  });

  it('reports an unsupported environment without crashing, in a browser lacking these APIs', async () => {
    // jsdom has none of Notification/PushManager/serviceWorker — this is effectively the
    // "unsupported browser" case, and the page must degrade to disabled controls, not throw.
    stubFetch();
    render(<ProbePage />);

    await waitFor(() => expect(screen.getByText(/Notification permission: unsupported/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Subscribe to push' })).toBeDisabled();
  });

  it('does not throw when Enable notifications is clicked in an unsupported browser', async () => {
    stubFetch();
    const user = userEvent.setup();
    render(<ProbePage />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Enable notifications' })).toBeDisabled());
    // Disabled buttons don't fire onClick via user-event, which is itself the assertion: the
    // guard in handleRequestPermission is backed by the disabled state, not just a try/catch.
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
  });

  it('runs the storage persistence check and displays the result', async () => {
    stubFetch();
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        persisted: async () => false,
        persist: async () => true,
        estimate: async () => ({ quota: 1_000_000_000, usage: 42 }),
      },
    });

    const user = userEvent.setup();
    render(<ProbePage />);

    await user.click(screen.getByRole('button', { name: 'Check storage persistence' }));

    await waitFor(() => expect(screen.getByText(/✓ Persistent storage granted/)).toBeInTheDocument());
    expect(screen.getByText(/Quota: 1000000000 bytes, usage: 42 bytes/)).toBeInTheDocument();
  });

  it('runs the background timer probe and reports ticks on stop', async () => {
    stubFetch();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ delay: null, advanceTimers: vi.advanceTimersByTime });
    render(<ProbePage />);

    await user.click(screen.getByRole('button', { name: 'Start (5s ticks)' }));
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    await user.click(screen.getByRole('button', { name: 'Stop & show results' }));

    expect(screen.getByText(/Ticks recorded: 4/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('merges the server log with a matching local receipt in the results table', async () => {
    stubFetch();
    await saveReceipt({
      kind: 'probe-push-receipt',
      sentAtIso: SERVER_LOG.sent[0]!.sentAtIso,
      receivedAtIso: '2026-08-02T09:00:20.900Z',
      burstIndex: 1,
      burstTotal: 1,
      retainedOptions: ['tag', 'renotify'],
    });

    const user = userEvent.setup();
    render(<ProbePage />);

    await user.click(screen.getByRole('button', { name: 'Refresh results' }));

    await waitFor(() => expect(screen.getByText('yes')).toBeInTheDocument());
    expect(screen.getByText('800 ms')).toBeInTheDocument(); // 09:00:20.900 - 09:00:20.100
    expect(screen.getByText('tag, renotify')).toBeInTheDocument();
  });

  it('shows a push as not yet seen when the server sent it but no local receipt exists', async () => {
    stubFetch();
    const user = userEvent.setup();
    render(<ProbePage />);

    await user.click(screen.getByRole('button', { name: 'Refresh results' }));

    await waitFor(() => expect(screen.getByText('not yet seen')).toBeInTheDocument());
  });

  it('clears local receipts without touching the server log', async () => {
    stubFetch();
    await saveReceipt({
      kind: 'probe-push-receipt',
      sentAtIso: SERVER_LOG.sent[0]!.sentAtIso,
      receivedAtIso: '2026-08-02T09:00:20.900Z',
      burstIndex: 1,
      burstTotal: 1,
      retainedOptions: [],
    });

    const user = userEvent.setup();
    render(<ProbePage />);

    await user.click(screen.getByRole('button', { name: 'Refresh results' }));
    await waitFor(() => expect(screen.getByText('yes')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Clear local receipts' }));

    await waitFor(() => expect(screen.getByText('not yet seen')).toBeInTheDocument());
  });

  it('copies the full results as text when the clipboard is available', async () => {
    stubFetch();
    // jsdom (v25+) provides a real navigator.clipboard that reasserts itself across renders, so
    // replacing the object outright doesn't stick — spy on the real method instead.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    const user = userEvent.setup();
    render(<ProbePage />);

    await user.click(screen.getByRole('button', { name: 'Copy full results' }));

    await waitFor(() => expect(screen.getByText('Copied.')).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledOnce();
    const copied = JSON.parse(writeText.mock.calls[0]![0] as string);
    expect(copied).toHaveProperty('probeId');
  });

  it('falls back to the visible textarea when the clipboard write is blocked', async () => {
    stubFetch();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

    const user = userEvent.setup();
    render(<ProbePage />);

    await user.click(screen.getByRole('button', { name: 'Copy full results' }));

    await waitFor(() => expect(screen.getByText(/Clipboard blocked/)).toBeInTheDocument());
  });
});
