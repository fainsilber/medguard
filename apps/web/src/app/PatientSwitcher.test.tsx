import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithRepository } from '../testUtils/renderWithRepository.js';
import { PatientSwitcher } from './PatientSwitcher.js';

afterEach(() => {
  localStorage.clear();
});

function makePatient(id: string, displayName: string, sortOrder: number) {
  return {
    id,
    displayName,
    archived: false,
    sortOrder,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced' as const,
  };
}

describe('PatientSwitcher', () => {
  it('renders nothing for a single-patient household', async () => {
    await renderWithRepository(
<PatientSwitcher />,
      { seed: async (repository) => repository.savePatient(makePatient('p-1', 'Yoni', 0), 'CREATE') },
    );

    // Give the live query a tick to settle before asserting absence.
    await waitFor(() => expect(screen.queryByLabelText('Patient')).not.toBeInTheDocument());
  });

  it('lists every patient plus "All patients", ordered by sortOrder', async () => {
    await renderWithRepository(
<PatientSwitcher />,
      {
        seed: async (repository) => {
          await repository.savePatient(makePatient('dad', 'Dad', 1), 'CREATE');
          await repository.savePatient(makePatient('yoni', 'Yoni', 0), 'CREATE');
        },
      },
    );

    const select = await screen.findByLabelText('Patient');
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['All patients', 'Yoni', 'Dad']);
  });

  it('selecting a patient updates the stored selection', async () => {
    const user = userEvent.setup();
    await renderWithRepository(
<PatientSwitcher />,
      {
        seed: async (repository) => {
          await repository.savePatient(makePatient('yoni', 'Yoni', 0), 'CREATE');
          await repository.savePatient(makePatient('dad', 'Dad', 1), 'CREATE');
        },
      },
    );

    const select = await screen.findByLabelText('Patient');
    await user.selectOptions(select, 'yoni');

    expect(localStorage.getItem('medguard.selectedPatientId')).toBe('yoni');
  });
});
