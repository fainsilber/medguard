import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { ScheduleList } from './ScheduleList.js';

const TODAY = '2026-06-15';
const CLOCK = fixedClock(`${TODAY}T12:00:00.000Z`);
const TIME_ZONE = 'UTC';

afterEach(() => {
  localStorage.clear();
});

async function renderScheduleList() {
  return renderWithRepository(<ScheduleList medicineId="medicine-1" />, {
    clock: CLOCK,
    timeZone: TIME_ZONE,
  });
}

/**
 * `type="time"`/`type="date"` inputs are segmented editors that `user.type()`'s keystroke
 * simulation handles unreliably (a known RTL/jsdom quirk — typing "08:00" character by
 * character can land on the wrong minute). `fireEvent.change` sets the value directly instead.
 */
function setFieldValue(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('ScheduleList', () => {
  it('shows no active schedule before one is created', async () => {
    await renderScheduleList();
    expect(await screen.findByText('No active schedule.')).toBeInTheDocument();
  });

  it('creates a daily schedule', async () => {
    const user = userEvent.setup();
    await renderScheduleList();
    await screen.findByText('No active schedule.');

    await user.click(screen.getByRole('button', { name: '+ Add schedule' }));
    setFieldValue('Time 1', '08:00');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Every day at 08:00 — 1')).toBeInTheDocument();
  });

  it('creates an interval schedule', async () => {
    const user = userEvent.setup();
    await renderScheduleList();
    await screen.findByText('No active schedule.');

    await user.click(screen.getByRole('button', { name: '+ Add schedule' }));
    await user.selectOptions(screen.getByLabelText('Frequency'), 'interval_days');
    const intervalInput = screen.getByLabelText('Every how many days');
    await user.clear(intervalInput);
    await user.type(intervalInput, '3');
    setFieldValue('Time 1', '09:00');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Every 3 days at 09:00 — 1')).toBeInTheDocument();
  });

  it('creates a specific-days schedule', async () => {
    const user = userEvent.setup();
    await renderScheduleList();
    await screen.findByText('No active schedule.');

    await user.click(screen.getByRole('button', { name: '+ Add schedule' }));
    await user.selectOptions(screen.getByLabelText('Frequency'), 'specific_days');
    await user.click(screen.getByRole('checkbox', { name: 'Mon' }));
    await user.click(screen.getByRole('checkbox', { name: 'Wed' }));
    await user.click(screen.getByRole('checkbox', { name: 'Fri' }));
    setFieldValue('Time 1', '08:00');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Mon/Wed/Fri at 08:00 — 1')).toBeInTheDocument();
  });

  it('rejects specific-days with no day selected', async () => {
    const user = userEvent.setup();
    await renderScheduleList();
    await screen.findByText('No active schedule.');

    await user.click(screen.getByRole('button', { name: '+ Add schedule' }));
    await user.selectOptions(screen.getByLabelText('Frequency'), 'specific_days');
    setFieldValue('Time 1', '08:00');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one day/i);
  });

  it('supports more than one time of day', async () => {
    const user = userEvent.setup();
    await renderScheduleList();
    await screen.findByText('No active schedule.');

    await user.click(screen.getByRole('button', { name: '+ Add schedule' }));
    setFieldValue('Time 1', '08:00');
    await user.click(screen.getByRole('button', { name: '+ Add a time' }));
    setFieldValue('Time 2', '20:00');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Every day at 08:00, 20:00 — 1')).toBeInTheDocument();
  });

  it('rejects a submission with no valid time of day', async () => {
    // The form starts pre-filled with a sensible default time, so this has to explicitly clear
    // it to reach the "no time" case rather than the "never touched" one.
    const user = userEvent.setup();
    await renderScheduleList();
    await screen.findByText('No active schedule.');

    await user.click(screen.getByRole('button', { name: '+ Add schedule' }));
    setFieldValue('Time 1', '');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least one time/i);
  });

  it('revises a schedule rather than editing it in place', async () => {
    const user = userEvent.setup();
    await renderScheduleList();
    await screen.findByText('No active schedule.');

    await user.click(screen.getByRole('button', { name: '+ Add schedule' }));
    setFieldValue('Time 1', '08:00');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Every day at 08:00 — 1');

    await user.click(screen.getByRole('button', { name: 'Change' }));
    const quantityInput = screen.getByLabelText('Dose quantity');
    await user.clear(quantityInput);
    await user.type(quantityInput, '2');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // The new version is the one active going forward...
    expect(await screen.findByText('Every day at 08:00 — 2')).toBeInTheDocument();
    // ...and the old version is preserved, not overwritten, as a past schedule.
    const pastSection = screen.getByText(/Past schedules/);
    await user.click(pastSection);
    expect(
      within(pastSection.closest('details')!).getByText(/Every day at 08:00 — 1/),
    ).toBeInTheDocument();
  });

  it('stops a schedule with no replacement', async () => {
    const user = userEvent.setup();
    await renderScheduleList();
    await screen.findByText('No active schedule.');

    await user.click(screen.getByRole('button', { name: '+ Add schedule' }));
    setFieldValue('Time 1', '08:00');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Every day at 08:00 — 1');

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(screen.getByText('No active schedule.')).toBeInTheDocument());
    expect(screen.getByText(/Past schedules/)).toBeInTheDocument();
  });

  it('rejects an end date before the start date', async () => {
    const user = userEvent.setup();
    await renderScheduleList();
    await screen.findByText('No active schedule.');

    await user.click(screen.getByRole('button', { name: '+ Add schedule' }));
    setFieldValue('Time 1', '08:00');
    setFieldValue('Start date', '2026-06-15');
    setFieldValue(/End date/, '2026-06-01');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/end date/i);
  });

  it('supports a bounded course with an end date', async () => {
    const user = userEvent.setup();
    await renderScheduleList();
    await screen.findByText('No active schedule.');

    await user.click(screen.getByRole('button', { name: '+ Add schedule' }));
    setFieldValue('Time 1', '08:00');
    setFieldValue(/End date/, '2026-06-20');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Every day at 08:00 — 1')).toBeInTheDocument();
  });

  it('cancels out of the form without creating anything', async () => {
    const user = userEvent.setup();
    await renderScheduleList();
    await screen.findByText('No active schedule.');

    await user.click(screen.getByRole('button', { name: '+ Add schedule' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('No active schedule.')).toBeInTheDocument();
  });
});
