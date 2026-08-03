import 'fake-indexeddb/auto';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import type { IntakeLog } from '@medguard/shared';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { DoseCorrection } from './DoseCorrection.js';

const TIME_ZONE = 'UTC';

afterEach(() => {
  localStorage.clear();
});

function log(overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id: 'log-1',
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    type: 'prn',
    status: 'taken',
    actualTime: '2026-06-15T11:30:00.000Z',
    quantityTaken: 2,
    loggedByUserId: 'Mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('DoseCorrection', () => {
  it('shows a Correct control and no history for a log that has never been corrected', async () => {
    const original = log();
    await renderWithRepository(<DoseCorrection allLogs={[original]} tipLog={original} timeZone={TIME_ZONE} />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
    });

    expect(screen.getByRole('button', { name: 'Correct' })).toBeInTheDocument();
    expect(screen.queryByText(/History/)).not.toBeInTheDocument();
  });

  it('opens a correction form pre-filled with the original values', async () => {
    const user = userEvent.setup();
    const original = log({ status: 'taken', quantityTaken: 2, actualTime: '2026-06-15T11:30:00.000Z' });
    await renderWithRepository(<DoseCorrection allLogs={[original]} tipLog={original} timeZone={TIME_ZONE} />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
    });

    await user.click(screen.getByRole('button', { name: 'Correct' }));

    expect(screen.getByLabelText('Status')).toHaveValue('taken');
    expect(screen.getByLabelText('Quantity')).toHaveValue(2);
    expect(screen.getByLabelText('Date')).toHaveValue('2026-06-15');
    expect(screen.getByLabelText('Time')).toHaveValue('11:30');
  });

  it('requires a reason before it will save a correction', async () => {
    const user = userEvent.setup();
    const original = log();
    await renderWithRepository(<DoseCorrection allLogs={[original]} tipLog={original} timeZone={TIME_ZONE} />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => repository.recordDose(original).then(() => undefined),
    });

    await user.click(screen.getByRole('button', { name: 'Correct' }));
    await user.click(screen.getByRole('button', { name: 'Save correction' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Say what was wrong');
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeInTheDocument();
  });

  it('saves a correction with a reason, closing the form afterward', async () => {
    const user = userEvent.setup();
    const original = log();
    await renderWithRepository(<DoseCorrection allLogs={[original]} tipLog={original} timeZone={TIME_ZONE} />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: (repository) => repository.recordDose(original).then(() => undefined),
    });

    await user.click(screen.getByRole('button', { name: 'Correct' }));
    await user.type(screen.getByLabelText('What was wrong?'), 'Actually only gave half a dose');
    await user.click(screen.getByRole('button', { name: 'Save correction' }));

    expect(await screen.findByRole('button', { name: 'Correct' })).toBeInTheDocument();
  });

  it('shows the full correction chain, oldest first, once a log has been corrected', async () => {
    const user = userEvent.setup();
    const original = log({ id: 'log-1', quantityTaken: 2, actualTime: '2026-06-15T11:30:00.000Z' });
    const correction = log({
      id: 'log-2',
      quantityTaken: 1,
      actualTime: '2026-06-15T11:31:00.000Z',
      supersedesId: 'log-1',
      notes: 'Actually only gave half',
    });

    await renderWithRepository(
      <DoseCorrection allLogs={[original, correction]} tipLog={correction} timeZone={TIME_ZONE} />,
      { clock: fixedClock('2026-06-15T12:00:00.000Z'), timeZone: TIME_ZONE },
    );

    const historyButton = screen.getByRole('button', { name: 'History (2)' });
    await user.click(historyButton);

    const entries = screen.getAllByRole('listitem');
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveTextContent('Taken (2)');
    expect(entries[1]).toHaveTextContent('Taken (1)');
    expect(entries[1]).toHaveTextContent('Actually only gave half');
  });
});
