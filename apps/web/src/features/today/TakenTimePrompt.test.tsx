import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fromIso } from '@medguard/shared';
import { TakenTimePrompt } from './TakenTimePrompt.js';

/**
 * Reverse-direction mirror of `apps/android/src/features/today/TakenTimePrompt.test.tsx` — the
 * Android file existed and this one didn't, despite the component being identical in purpose: a
 * patient-safety timestamp (what seeds the rolling-24h PRN cap window) had a direct test on one
 * platform and only transitive coverage (via `TodayView.test.tsx`) on the other.
 *
 * Not ported: Android's "rejects a malformed custom time" test. Web's `<input type="time">` is a
 * real HTML time control — a browser constrains it to a valid HH:MM or empty before `customTime`
 * ever updates, so there is no application-level validation branch here to test (unlike Android's
 * plain text field, which needs one). jsdom doesn't enforce that constraint the way a real browser
 * does, but a test exploiting that gap would be proving a jsdom quirk, not real behavior.
 */

const DUE_AT = '2026-06-15T08:00:00.000Z'; // 08:00 UTC
const NOW_MS = fromIso('2026-06-15T09:30:00.000Z'); // 09:30 UTC — the dose is overdue

function renderPrompt(overrides: { onConfirm?: (iso: string) => void; onCancel?: () => void } = {}) {
  const onConfirm = overrides.onConfirm ?? vi.fn();
  const onCancel = overrides.onCancel ?? vi.fn();
  render(
    <TakenTimePrompt
      dueAtIso={DUE_AT}
      nowMs={NOW_MS}
      timeZone="UTC"
      saving={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe('TakenTimePrompt', () => {
  it('"On time" confirms with the due instant, unmodified', () => {
    const { onConfirm } = renderPrompt();

    fireEvent.click(screen.getByText(/On time/));

    expect(onConfirm).toHaveBeenCalledWith(DUE_AT);
  });

  it('"Just now" confirms with the current instant', () => {
    const { onConfirm } = renderPrompt();

    fireEvent.click(screen.getByText(/Just now/));

    expect(onConfirm).toHaveBeenCalledWith('2026-06-15T09:30:00.000Z');
  });

  it('"Another time" resolves a custom HH:MM against the due date, not today', async () => {
    const { onConfirm } = renderPrompt();

    fireEvent.click(screen.getByText('Another time'));
    const input = await waitFor(() => screen.getByLabelText('Time taken'));
    fireEvent.change(input, { target: { value: '07:45' } });
    fireEvent.click(screen.getByText('Save'));

    // The due date is 2026-06-15 (UTC) — a custom time resolves against that day, even though
    // "now" is also 2026-06-15 here. The more important case (crossing midnight) is covered by
    // resolveLocal's own tests in packages/shared; this proves TakenTimePrompt actually calls it
    // with the due date, not `new Date()`'s today.
    expect(onConfirm).toHaveBeenCalledWith('2026-06-15T07:45:00.000Z');
  });

  it('the custom-time field starts pre-filled with "now", not blank', async () => {
    renderPrompt();

    fireEvent.click(screen.getByText('Another time'));

    const input = await waitFor(() => screen.getByLabelText('Time taken'));
    expect(input).toHaveValue('09:30');
  });

  it('Cancel calls onCancel without confirming anything', () => {
    const { onConfirm, onCancel } = renderPrompt();

    fireEvent.click(screen.getByText('Cancel'));

    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
