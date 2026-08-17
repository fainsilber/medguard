import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { PatientRosterCard } from './PatientRosterCard.js';

afterEach(() => {
  localStorage.clear();
});

function makePatient(id: string, displayName: string, sortOrder: number, archived = false) {
  return {
    id,
    displayName,
    archived,
    sortOrder,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced' as const,
  };
}

describe('PatientRosterCard', () => {
  it('adds a new patient', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<PatientRosterCard />, { clock: fixedClock('2026-08-03T12:00:00.000Z') });

    await user.type(screen.getByLabelText('New patient name'), 'Yoni');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByText('Yoni')).toBeInTheDocument();
    expect(screen.getByLabelText('New patient name')).toHaveValue('');
  });

  it('lists patients in sortOrder', async () => {
    await renderWithRepository(<PatientRosterCard />, {
      seed: async (repository) => {
        await repository.savePatient(makePatient('dad', 'Dad', 1), 'CREATE');
        await repository.savePatient(makePatient('yoni', 'Yoni', 0), 'CREATE');
      },
    });

    const names = (await screen.findAllByRole('button', { name: /^(Yoni|Dad)$/ })).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(['Yoni', 'Dad']);
  });

  it('renames a patient', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<PatientRosterCard />, {
      seed: async (repository) => repository.savePatient(makePatient('p-1', 'Yoni', 0), 'CREATE'),
    });

    await user.click(await screen.findByRole('button', { name: 'Yoni' }));
    const input = screen.getByLabelText('Rename Yoni');
    await user.clear(input);
    await user.type(input, 'Yonatan');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Yonatan')).toBeInTheDocument();
    expect(screen.queryByText('Yoni')).not.toBeInTheDocument();
  });

  it('reorders patients with the up/down buttons', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<PatientRosterCard />, {
      seed: async (repository) => {
        await repository.savePatient(makePatient('yoni', 'Yoni', 0), 'CREATE');
        await repository.savePatient(makePatient('dad', 'Dad', 1), 'CREATE');
      },
    });

    await screen.findByRole('button', { name: 'Yoni' });
    await user.click(screen.getByRole('button', { name: 'Move Yoni down' }));

    await waitFor(() => {
      const names = screen
        .getAllByRole('button', { name: /^(Yoni|Dad)$/ })
        .map((el) => el.textContent);
      expect(names).toEqual(['Dad', 'Yoni']);
    });
  });

  it('archives a patient, removing it from the active list', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<PatientRosterCard />, {
      seed: async (repository) => repository.savePatient(makePatient('p-1', 'Yoni', 0), 'CREATE'),
    });

    await screen.findByRole('button', { name: 'Yoni' });
    await user.click(screen.getByRole('button', { name: 'Archive' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Yoni' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Show archived (1)' })).toBeInTheDocument();
  });

  it('restores an archived patient', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<PatientRosterCard />, {
      seed: async (repository) => repository.savePatient(makePatient('p-1', 'Yoni', 0, true), 'CREATE'),
    });

    await user.click(await screen.findByRole('button', { name: /Show archived/ }));
    await user.click(screen.getByRole('button', { name: 'Restore' }));

    expect(await screen.findByRole('button', { name: 'Yoni' })).toBeInTheDocument();
  });
});
