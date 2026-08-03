import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { MedicineList } from './MedicineList.js';

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

  it('shows the PRN guard summary when configured', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<MedicineList />);
    await screen.findByText('No medicines yet.');

    await user.click(screen.getByRole('button', { name: '+ Add medicine' }));
    await user.type(screen.getByLabelText('Name'), 'Ondansetron');
    await user.type(screen.getByLabelText('Strength'), '4mg');
    await user.type(screen.getByLabelText('Min hours between doses'), '4');
    await user.type(screen.getByLabelText('Max doses / day'), '4');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/Min 4h between doses · Max 4\/day/)).toBeInTheDocument();
  });

  it('does not show a guard summary for a medicine with no guards', async () => {
    await renderWithRepository(<MedicineList />);
    await screen.findByText('No medicines yet.');
    await addMedicine('Vitamin D');

    expect(screen.queryByText(/between doses/)).not.toBeInTheDocument();
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
