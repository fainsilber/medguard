import 'fake-indexeddb/auto';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import type { MedGuardRepository } from '@medguard/store';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { InventoryScreen } from './InventoryScreen.js';

const TIME_ZONE = 'UTC';

afterEach(() => {
  localStorage.clear();
});

async function seedMedicine(repository: MedGuardRepository) {
  await repository.saveMedicine(
    {
      id: 'medicine-1',
      patientId: 'patient-1',
      name: 'Ondansetron',
      strength: '4mg',
      form: 'pill',
      asNeeded: false,
      archived: false,
      updatedAt: '2026-06-01T00:00:00.000Z',
      updatedByDeviceId: 'seed',
      syncStatus: 'synced',
    },
    'CREATE',
  );
}

describe('InventoryScreen', () => {
  it('shows nothing to track when there are no medicines', async () => {
    await renderWithRepository(<InventoryScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
    });

    expect(await screen.findByText('No medicines yet.')).toBeInTheDocument();
  });

  it('offers to start tracking stock for a medicine with none configured', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<InventoryScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: seedMedicine,
    });

    await user.click(await screen.findByRole('button', { name: 'Track stock' }));
    expect(screen.getByText('Stock isn’t tracked for this medicine yet.')).toBeInTheDocument();
  });

  it('sets up tracking with a starting count and then shows the stock card', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<InventoryScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: seedMedicine,
    });

    await user.click(await screen.findByRole('button', { name: 'Track stock' }));
    await user.clear(screen.getByLabelText('Unit'));
    await user.type(screen.getByLabelText('Unit'), 'bottles');
    await user.type(screen.getByLabelText('Refill at'), '2');
    await user.type(screen.getByLabelText('Starting count'), '10');
    await user.click(screen.getByRole('button', { name: 'Start tracking stock' }));

    expect(await screen.findByText('10 bottles remaining')).toBeInTheDocument();
  });

  it('shows a low-stock banner and badge once stock falls to the refill threshold', async () => {
    await renderWithRepository(<InventoryScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedMedicine(repository);
        await repository.saveInventoryItem(
          {
            id: 'item-1',
            medicineId: 'medicine-1',
            refillThreshold: 5,
            unitName: 'pills',
            updatedAt: '2026-06-01T00:00:00.000Z',
            updatedByDeviceId: 'seed',
            syncStatus: 'synced',
          },
          'CREATE',
        );
        await repository.adjustInventory({ medicineId: 'medicine-1', delta: 5, reason: 'initial' });
      },
    });

    expect(await screen.findByText(/Running low: Ondansetron/)).toBeInTheDocument();
    expect(screen.getByText('Low stock')).toBeInTheDocument();
  });

  it('records a manual adjustment and updates the displayed quantity', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<InventoryScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedMedicine(repository);
        await repository.saveInventoryItem(
          {
            id: 'item-1',
            medicineId: 'medicine-1',
            refillThreshold: 2,
            unitName: 'pills',
            updatedAt: '2026-06-01T00:00:00.000Z',
            updatedByDeviceId: 'seed',
            syncStatus: 'synced',
          },
          'CREATE',
        );
        await repository.adjustInventory({ medicineId: 'medicine-1', delta: 20, reason: 'initial' });
      },
    });

    await screen.findByText('20 pills remaining');
    await user.click(screen.getByRole('button', { name: 'Adjust stock' }));

    const form = screen.getByRole('button', { name: 'Save' }).closest('form')!;
    await user.selectOptions(within(form).getByLabelText('Reason'), 'refill');
    await user.type(within(form).getByLabelText('Amount'), '5');
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('25 pills remaining')).toBeInTheDocument();
  });

  it('flags a negative stock count distinctly from ordinary low stock', async () => {
    await renderWithRepository(<InventoryScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedMedicine(repository);
        await repository.saveInventoryItem(
          {
            id: 'item-1',
            medicineId: 'medicine-1',
            refillThreshold: 2,
            unitName: 'pills',
            updatedAt: '2026-06-01T00:00:00.000Z',
            updatedByDeviceId: 'seed',
            syncStatus: 'synced',
          },
          'CREATE',
        );
        await repository.adjustInventory({ medicineId: 'medicine-1', delta: -3, reason: 'lost' });
      },
    });

    expect(await screen.findByText('Stock count is negative — recount needed')).toBeInTheDocument();
  });
});
