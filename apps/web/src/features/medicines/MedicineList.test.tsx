import 'fake-indexeddb/auto';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { MedGuardRepository } from '@medguard/store';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { MedicineList } from './MedicineList.js';

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

afterEach(() => {
  localStorage.clear();
});

async function addMedicine(name: string, strength = '5mg') {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '+ Add medicine' }));
  await user.type(screen.getByLabelText('Name'), name);
  await user.type(screen.getByLabelText('Strength'), strength);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());
}

describe('MedicineList', () => {
  it('shows an empty state before anything is added', async () => {
    await renderWithRepository(<MedicineList />);
    expect(await screen.findByText('No medicines yet.')).toBeInTheDocument();
  });

  it('adds a medicine and shows it in the list', async () => {
    await renderWithRepository(<MedicineList />);
    await screen.findByText('No medicines yet.');
    await addMedicine('Ondansetron', '4mg');

    expect(screen.getByText('Ondansetron')).toBeInTheDocument();
    expect(screen.getByText('4mg')).toBeInTheDocument();
  });

  it('shows the as-needed guard summary when configured', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<MedicineList />);
    await screen.findByText('No medicines yet.');

    await user.click(screen.getByRole('button', { name: '+ Add medicine' }));
    await user.type(screen.getByLabelText('Name'), 'Ondansetron');
    await user.type(screen.getByLabelText('Strength'), '4mg');
    await user.click(screen.getByRole('radio', { name: /As needed/ }));
    await user.type(screen.getByLabelText('Min hours between doses'), '4');
    await user.type(screen.getByLabelText('Max doses / day'), '4');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('as needed')).toBeInTheDocument();
    expect(await screen.findByText(/Min 4h between doses · Max 4\/day/)).toBeInTheDocument();
  });

  it('does not show a guard summary for a medicine with no guards', async () => {
    await renderWithRepository(<MedicineList />);
    await screen.findByText('No medicines yet.');
    await addMedicine('Vitamin D');

    expect(screen.queryByText(/between doses/)).not.toBeInTheDocument();
  });

  it('opens the schedule editor inside the row of the medicine it belongs to', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<MedicineList />, { timeZone: 'UTC' });
    await screen.findByText('No medicines yet.');
    await addMedicine('Prednisone');
    await addMedicine('Ondansetron');

    // Expand the *first* medicine's schedule. Rendered below the whole list, as it used to be, the
    // panel would sit under Ondansetron and read as belonging to it instead.
    const prednisoneRow = screen
      .getAllByRole('listitem')
      .find((row) => row.textContent?.includes('Prednisone'))!;
    await user.click(within(prednisoneRow).getByRole('button', { name: 'Schedule' }));

    expect(await within(prednisoneRow).findByText('No active schedule.')).toBeInTheDocument();

    const ondansetronRow = screen
      .getAllByRole('listitem')
      .find((row) => row.textContent?.includes('Ondansetron'))!;
    expect(within(ondansetronRow).queryByText('No active schedule.')).not.toBeInTheDocument();
  });

  it('only offers to manage a schedule for a medicine that is not as-needed', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<MedicineList />);
    await screen.findByText('No medicines yet.');
    await addMedicine('Prednisone');

    await user.click(screen.getByRole('button', { name: '+ Add medicine' }));
    await user.type(screen.getByLabelText('Name'), 'Ondansetron');
    await user.type(screen.getByLabelText('Strength'), '4mg');
    await user.click(screen.getByRole('radio', { name: /As needed/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Ondansetron');

    expect(screen.getAllByRole('button', { name: 'Schedule' })).toHaveLength(1);
  });

  it('archives a medicine instead of deleting it', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<MedicineList />);
    await screen.findByText('No medicines yet.');
    await addMedicine('Ondansetron');

    await user.click(screen.getByRole('button', { name: 'Archive' }));

    // Gone from the default (active-only) view...
    await waitFor(() => expect(screen.queryByText('Ondansetron')).not.toBeInTheDocument());

    // ...but still there, marked, once archived items are shown — never actually deleted.
    await user.click(screen.getByRole('checkbox', { name: 'Show archived' }));
    expect(await screen.findByText('Ondansetron')).toBeInTheDocument();
    expect(screen.getByText('archived')).toBeInTheDocument();
  });

  it('does not offer to archive an already-archived medicine', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<MedicineList />);
    await screen.findByText('No medicines yet.');
    await addMedicine('Ondansetron');
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await user.click(screen.getByRole('checkbox', { name: 'Show archived' }));
    await screen.findByText('archived');

    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('edits a medicine in place', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<MedicineList />);
    await screen.findByText('No medicines yet.');
    await addMedicine('Ondansetron', '4mg');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const strengthInput = screen.getByLabelText('Strength');
    await user.clear(strengthInput);
    await user.type(strengthInput, '8mg');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('8mg')).toBeInTheDocument();
    expect(screen.queryByText('4mg')).not.toBeInTheDocument();
  });

  it('cancels out of the form without saving', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<MedicineList />);
    await screen.findByText('No medicines yet.');

    await user.click(screen.getByRole('button', { name: '+ Add medicine' }));
    await user.type(screen.getByLabelText('Name'), 'Should not save');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByText('No medicines yet.')).toBeInTheDocument();
  });
});

describe('medicine ↔ patient assignment', () => {
  it('assigns a new medicine to the patient checked in the form', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;
    await renderWithRepository(<MedicineList />, {
      seed: async (seedRepository) => {
        repository = seedRepository;
        await seedRepository.savePatient(makePatient('yoni', 'Yoni', 0), 'CREATE');
        await seedRepository.savePatient(makePatient('dad', 'Dad', 1), 'CREATE');
      },
    });
    await screen.findByText('No medicines yet.');

    await user.click(screen.getByRole('button', { name: '+ Add medicine' }));
    await user.type(screen.getByLabelText('Name'), 'Ondansetron');
    await user.type(screen.getByLabelText('Strength'), '4mg');
    await user.click(screen.getByRole('checkbox', { name: 'Yoni' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Ondansetron');

    const [medicine] = await repository!.allMedicines();
    const assigned = await repository!.patientsForMedicine(medicine!.id);
    expect(assigned.map((p) => p.displayName)).toEqual(['Yoni']);
  });

  it('shares a medicine by checking more than one patient', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;
    await renderWithRepository(<MedicineList />, {
      seed: async (seedRepository) => {
        repository = seedRepository;
        await seedRepository.savePatient(makePatient('yoni', 'Yoni', 0), 'CREATE');
        await seedRepository.savePatient(makePatient('dad', 'Dad', 1), 'CREATE');
      },
    });
    await screen.findByText('No medicines yet.');

    await user.click(screen.getByRole('button', { name: '+ Add medicine' }));
    await user.type(screen.getByLabelText('Name'), 'Paracetamol');
    await user.type(screen.getByLabelText('Strength'), '500mg');
    await user.click(screen.getByRole('checkbox', { name: 'Yoni' }));
    await user.click(screen.getByRole('checkbox', { name: 'Dad' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Paracetamol');

    const [medicine] = await repository!.allMedicines();
    const assigned = await repository!.patientsForMedicine(medicine!.id);
    expect(assigned.map((p) => p.displayName).sort()).toEqual(['Dad', 'Yoni']);
  });

  it('editing to uncheck a patient unassigns them', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;
    await renderWithRepository(<MedicineList />, {
      seed: async (seedRepository) => {
        repository = seedRepository;
        await seedRepository.savePatient(makePatient('yoni', 'Yoni', 0), 'CREATE');
        await seedRepository.savePatient(makePatient('dad', 'Dad', 1), 'CREATE');
      },
    });
    await screen.findByText('No medicines yet.');

    await user.click(screen.getByRole('button', { name: '+ Add medicine' }));
    await user.type(screen.getByLabelText('Name'), 'Paracetamol');
    await user.type(screen.getByLabelText('Strength'), '500mg');
    await user.click(screen.getByRole('checkbox', { name: 'Yoni' }));
    await user.click(screen.getByRole('checkbox', { name: 'Dad' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Paracetamol');

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    // Pre-checked from the existing assignment, both boxes checked; uncheck Dad.
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Dad' })).toBeChecked());
    await user.click(screen.getByRole('checkbox', { name: 'Dad' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Paracetamol');

    const [medicine] = await repository!.allMedicines();
    const assigned = await repository!.patientsForMedicine(medicine!.id);
    expect(assigned.map((p) => p.displayName)).toEqual(['Yoni']);
  });

  it('filters the list to the selected patient, showing a shared medicine for either one', async () => {
    localStorage.setItem('medguard.selectedPatientId', 'yoni');

    await renderWithRepository(<MedicineList />, {
      seed: async (repository) => {
        await repository.savePatient(makePatient('yoni', 'Yoni', 0), 'CREATE');
        await repository.savePatient(makePatient('dad', 'Dad', 1), 'CREATE');
        await repository.saveMedicine(
          {
            id: 'private-to-dad',
            name: 'Statin',
            strength: '10mg',
            form: 'pill',
            asNeeded: false,
            archived: false,
            updatedAt: '2026-01-01T00:00:00.000Z',
            updatedByDeviceId: 'seed',
            syncStatus: 'synced',
          },
          'CREATE',
        );
        await repository.saveMedicine(
          {
            id: 'shared',
            name: 'Paracetamol',
            strength: '500mg',
            form: 'pill',
            asNeeded: true,
            archived: false,
            updatedAt: '2026-01-01T00:00:00.000Z',
            updatedByDeviceId: 'seed',
            syncStatus: 'synced',
          },
          'CREATE',
        );
        await repository.assignMedicine('private-to-dad', 'dad');
        await repository.assignMedicine('shared', 'yoni');
        await repository.assignMedicine('shared', 'dad');
      },
    });

    expect(await screen.findByText('Paracetamol')).toBeInTheDocument();
    expect(screen.queryByText('Statin')).not.toBeInTheDocument();
  });
});
