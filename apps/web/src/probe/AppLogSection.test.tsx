import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appLog, clearAppLog } from '../logging/appLog.js';
import { AppLogSection } from './AppLogSection.js';

let capturedBlob: Blob | undefined;

/** `Blob.prototype.text()` isn't available in this jsdom setup; `FileReader` is. */
function readBlobAsText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read blob'));
    reader.readAsText(blob);
  });
}

beforeEach(() => {
  clearAppLog();
  capturedBlob = undefined;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    capturedBlob = blob;
    return 'blob:mock';
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  clearAppLog();
  vi.restoreAllMocks();
});

describe('AppLogSection', () => {
  it('shows a placeholder and disables every action when nothing has been logged', () => {
    render(<AppLogSection />);

    expect(screen.getByText('Nothing logged yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export logs' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy logs' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
  });

  it('lists recorded entries and updates live as new ones come in', async () => {
    appLog('sync').info('pull complete', { records: 2 });
    render(<AppLogSection />);

    expect(screen.getByText(/sync: pull complete/)).toBeInTheDocument();
    expect(screen.getByText('1 entries')).toBeInTheDocument();

    appLog('live').warn('connection closed');
    expect(await screen.findByText('2 entries')).toBeInTheDocument();
  });

  it('downloads the log as a text file', async () => {
    appLog('sync').info('pull complete');
    const user = userEvent.setup();
    render(<AppLogSection />);

    await user.click(screen.getByRole('button', { name: 'Export logs' }));

    expect(capturedBlob).toBeDefined();
    expect(capturedBlob?.type).toContain('text/plain');
    const text = await readBlobAsText(capturedBlob!);
    expect(text).toContain('sync: pull complete');
  });

  it('copies the log text to the clipboard', async () => {
    appLog('sync').info('pull complete');
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<AppLogSection />);

    await user.click(screen.getByRole('button', { name: 'Copy logs' }));

    await waitFor(() => expect(screen.getByText('Copied.')).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]![0]).toContain('sync: pull complete');
  });

  it('falls back to a visible error when the clipboard write is blocked', async () => {
    appLog('sync').info('pull complete');
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    const user = userEvent.setup();
    render(<AppLogSection />);

    await user.click(screen.getByRole('button', { name: 'Copy logs' }));

    await waitFor(() => expect(screen.getByText(/Clipboard blocked/)).toBeInTheDocument());
  });

  it('clears every recorded entry', async () => {
    appLog('sync').info('pull complete');
    const user = userEvent.setup();
    render(<AppLogSection />);

    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByText('Nothing logged yet.')).toBeInTheDocument();
  });
});
