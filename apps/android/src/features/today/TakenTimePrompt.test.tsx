import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { fromIso } from '@medguard/shared';
import { TakenTimePrompt } from './TakenTimePrompt.js';

/**
 * Pure presentational component (no repository) — driven entirely by props/callbacks, so this
 * renders directly with no `RepositoryProvider`. Covers the three resolution paths and the
 * invalid-HH:MM-input error path called out in the sprint plan.
 */

const DUE_AT = '2026-06-15T08:00:00.000Z'; // 08:00 UTC
const NOW_MS = fromIso('2026-06-15T09:30:00.000Z'); // 09:30 UTC — the dose is overdue

describe('TakenTimePrompt', () => {
  it('"On time" confirms with the due instant, unmodified', async () => {
    const onConfirm = jest.fn();
    const { getByText } = render(
      <TakenTimePrompt
        dueAtIso={DUE_AT}
        nowMs={NOW_MS}
        timeZone="UTC"
        saving={false}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(getByText(/On time/));

    expect(onConfirm).toHaveBeenCalledWith(DUE_AT);
  });

  it('"Just now" confirms with the current instant', async () => {
    const onConfirm = jest.fn();
    const { getByText } = render(
      <TakenTimePrompt
        dueAtIso={DUE_AT}
        nowMs={NOW_MS}
        timeZone="UTC"
        saving={false}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(getByText(/Just now/));

    expect(onConfirm).toHaveBeenCalledWith('2026-06-15T09:30:00.000Z');
  });

  it('"Another time" resolves a custom HH:MM against the due date, not today', async () => {
    const onConfirm = jest.fn();
    const { getByText, getByLabelText } = render(
      <TakenTimePrompt
        dueAtIso={DUE_AT}
        nowMs={NOW_MS}
        timeZone="UTC"
        saving={false}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(getByText('Another time'));
    const input = await waitFor(() => getByLabelText('Time taken'));
    fireEvent.changeText(input, '07:45');
    fireEvent.press(getByText('Save'));

    // The due date is 2026-06-15 (UTC) — a custom time resolves against that day, even though
    // "now" is also 2026-06-15 here. The more important case (crossing midnight) is covered by
    // resolveLocal's own tests in packages/shared; this proves TakenTimePrompt actually calls it
    // with the due date, not `new Date()`'s today.
    expect(onConfirm).toHaveBeenCalledWith('2026-06-15T07:45:00.000Z');
  });

  it('rejects a malformed custom time instead of silently confirming', async () => {
    const onConfirm = jest.fn();
    const { getByText, getByLabelText, queryByRole } = render(
      <TakenTimePrompt
        dueAtIso={DUE_AT}
        nowMs={NOW_MS}
        timeZone="UTC"
        saving={false}
        onConfirm={onConfirm}
        onCancel={jest.fn()}
      />,
    );

    fireEvent.press(getByText('Another time'));
    const input = await waitFor(() => getByLabelText('Time taken'));
    fireEvent.changeText(input, 'not a time');
    fireEvent.press(getByText('Save'));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(queryByRole('alert')).toBeTruthy();
  });

  it('Cancel calls onCancel without confirming anything', () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    const { getByText } = render(
      <TakenTimePrompt
        dueAtIso={DUE_AT}
        nowMs={NOW_MS}
        timeZone="UTC"
        saving={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.press(getByText('Cancel'));

    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
