import { fireEvent, waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import type { IntakeLog } from '@medguard/shared';
import { readLogsFromDb, seedLog } from '../../testUtils/readLogs.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { DoseCorrection } from './DoseCorrection.js';

/**
 * Corrections are append-only (safety invariant 1): "Correct" must never edit `tipLog` in place —
 * it appends a new log with `supersedesId` pointing at the original, which stays visible in
 * history. A missing "what was wrong?" note must block submission entirely.
 */

const NOW = '2026-06-15T12:00:00.000Z';

function makeLog(overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id: 'log-1',
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    scheduleId: 'schedule-1',
    type: 'scheduled',
    status: 'taken',
    scheduledTime: '2026-06-15T08:00:00.000Z',
    actualTime: '2026-06-15T08:05:00.000Z',
    quantityTaken: 1,
    loggedByUserId: 'Mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('DoseCorrection', () => {
  it('cannot submit a correction with an empty note', async () => {
    const original = makeLog();
    const { getByText, queryByText } = renderWithRepository(
      <DoseCorrection allLogs={[original]} tipLog={original} timeZone="UTC" />,
      { clock: fixedClock(NOW), dbName: 'dose-correction-empty-note.db' },
    );

    await waitFor(() => expect(getByText('Correct')).toBeTruthy());
    fireEvent.press(getByText('Correct'));
    await waitFor(() => expect(getByText('Save correction')).toBeTruthy());
    fireEvent.press(getByText('Save correction'));

    await waitFor(() =>
      expect(queryByText("Say what was wrong — it's recorded permanently alongside the correction.")).toBeTruthy(),
    );
    expect(await readLogsFromDb('dose-correction-empty-note.db', 'medicine-1')).toHaveLength(0);
  });

  it('appends a correction rather than editing the original — both remain, linked by supersedesId', async () => {
    const dbName = 'dose-correction-append.db';
    const original = makeLog();
    await seedLog(dbName, original);
    const { getByText, getByLabelText } = renderWithRepository(
      <DoseCorrection allLogs={[original]} tipLog={original} timeZone="UTC" />,
      { clock: fixedClock(NOW), dbName },
    );

    await waitFor(() => expect(getByText('Correct')).toBeTruthy());
    fireEvent.press(getByText('Correct'));
    await waitFor(() => expect(getByLabelText('What was wrong?')).toBeTruthy());
    fireEvent.changeText(getByLabelText('What was wrong?'), 'Miscounted the dose given');
    fireEvent.press(getByText('Save correction'));

    let logs: IntakeLog[] = [];
    await waitFor(async () => {
      logs = await readLogsFromDb(dbName, 'medicine-1');
      expect(logs).toHaveLength(2);
    });

    // Both remain: the seeded original, untouched, plus a new correction pointing back at it —
    // never the original rewritten in place.
    const stillOriginal = logs.find((log) => log.id === 'log-1');
    const correction = logs.find((log) => log.id !== 'log-1');
    expect(stillOriginal).toBeDefined();
    expect(stillOriginal?.notes).toBeUndefined();
    expect(correction?.supersedesId).toBe('log-1');
    expect(correction?.notes).toBe('Miscounted the dose given');
  });

  it('shows the full correction chain, oldest first, once a correction exists', async () => {
    const original = makeLog({ id: 'original', status: 'taken', quantityTaken: 2 });
    const correction = makeLog({
      id: 'correction',
      supersedesId: 'original',
      status: 'taken',
      quantityTaken: 1,
      notes: 'Miscounted the dose',
      loggedByUserId: 'Dad',
    });

    const { getByText, queryByText } = renderWithRepository(
      <DoseCorrection allLogs={[original, correction]} tipLog={correction} timeZone="UTC" />,
      { clock: fixedClock(NOW), dbName: 'dose-correction-history.db' },
    );

    await waitFor(() => expect(queryByText('History (2)')).toBeTruthy());
    fireEvent.press(getByText('History (2)'));

    await waitFor(() => expect(queryByText(/Miscounted the dose/)).toBeTruthy());
    expect(queryByText(/Taken \(2\)/)).toBeTruthy();
    expect(queryByText(/Taken \(1\)/)).toBeTruthy();
  });
});
