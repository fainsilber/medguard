import { fireEvent, waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { PatientRosterCard } from './PatientRosterCard.js';

const NOW = '2026-06-15T12:00:00.000Z';

describe('PatientRosterCard', () => {
  it('shows the bootstrapped default patient and adds a new one', async () => {
    const { getByText, getByPlaceholderText, findByText } = renderWithRepository(
      <PatientRosterCard />,
      { clock: fixedClock(NOW), dbName: 'patient-roster-add.db' },
    );

    await findByText('Patient');

    fireEvent.changeText(getByPlaceholderText('Patient name'), 'Dad');
    fireEvent.press(getByText('Add'));

    await waitFor(() => expect(getByText('Dad')).toBeTruthy());
  });

  it('renames a patient inline', async () => {
    const { getByText, getByDisplayValue, findByText } = renderWithRepository(
      <PatientRosterCard />,
      { clock: fixedClock(NOW), dbName: 'patient-roster-rename.db' },
    );

    await findByText('Patient');
    fireEvent.press(getByText('Patient'));

    const input = getByDisplayValue('Patient');
    fireEvent.changeText(input, 'Yoni');
    fireEvent.press(getByText('Save'));

    await waitFor(() => expect(getByText('Yoni')).toBeTruthy());
  });

  it('reorders two patients with the up/down buttons', async () => {
    const { getByText, getByPlaceholderText, getAllByText, findByText, toJSON } =
      renderWithRepository(<PatientRosterCard />, {
        clock: fixedClock(NOW),
        dbName: 'patient-roster-reorder.db',
      });

    await findByText('Patient');
    fireEvent.changeText(getByPlaceholderText('Patient name'), 'Dad');
    fireEvent.press(getByText('Add'));
    await waitFor(() => expect(getByText('Dad')).toBeTruthy());

    // "Patient" is first, "Dad" second (the default add-to-end order) — move Dad up.
    const treeBefore = JSON.stringify(toJSON());
    expect(treeBefore.indexOf('"Patient"')).toBeLessThan(treeBefore.indexOf('"Dad"'));

    fireEvent.press(getAllByText('↑')[1]!);

    await waitFor(() => {
      const treeAfter = JSON.stringify(toJSON());
      expect(treeAfter.indexOf('"Dad"')).toBeLessThan(treeAfter.indexOf('"Patient"'));
    });
  });

  it('archives a patient, hiding it from the active roster until restored', async () => {
    const { getByText, queryByText, findByText } = renderWithRepository(<PatientRosterCard />, {
      clock: fixedClock(NOW),
      dbName: 'patient-roster-archive.db',
    });

    await findByText('Patient');
    fireEvent.press(getByText('Archive'));

    await waitFor(() => expect(queryByText('Patient')).toBeNull());
    expect(getByText('Show archived (1)')).toBeTruthy();

    fireEvent.press(getByText('Show archived (1)'));
    await waitFor(() => expect(getByText('Restore')).toBeTruthy());

    fireEvent.press(getByText('Restore'));
    // Longer than this file's other waits: under a loaded test run this round-trips a write and a
    // live-query refresh through the SQLite test double twice in one test (archive, then restore).
    await waitFor(() => expect(queryByText('No patients yet.')).toBeNull(), { timeout: 5_000 });
  });
});
