import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import { fixedClock } from '@medguard/shared/testing';
import { AndroidInventoryScreen } from './AndroidInventoryScreen.js';
import { renderWithAndroidApp } from '../../testUtils/renderWithAndroidApp.js';
import { medicine } from '../../testUtils/fixtures.js';

const TIME_ZONE = 'Asia/Jerusalem';
const clock = fixedClock('2026-06-15T12:00:00.000Z');

const ondansetron = medicine({ id: 'med-1', name: 'Ondansetron' });

describe('AndroidInventoryScreen', () => {
  it('says so when there is nothing to track', async () => {
    await renderWithAndroidApp(<AndroidInventoryScreen />, { clock, timeZone: TIME_ZONE });

    expect(await screen.findByText(/no medicines to track yet/i)).toBeInTheDocument();
  });

  it('shows an untracked medicine as untracked rather than as zero stock', async () => {
    // "0 units" would read as "we are out", which is a different and alarming claim.
    await renderWithAndroidApp(<AndroidInventoryScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: (repository) => repository.saveMedicine(ondansetron),
    });

    expect(await screen.findByText(/not tracked/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set count/i })).toBeInTheDocument();
  });

  it('rejects a non-positive count', async () => {
    const user = userEvent.setup();
    await renderWithAndroidApp(<AndroidInventoryScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: (repository) => repository.saveMedicine(ondansetron),
    });

    await user.click(await screen.findByRole('button', { name: /set count/i }));
    await user.type(screen.getByLabelText(/units added/i), '0');
    await user.click(screen.getByRole('button', { name: /log refill/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/greater than zero/i);
  });

  it('records a first count as an initial ledger entry', async () => {
    const user = userEvent.setup();
    const { repository, db } = await renderWithAndroidApp(<AndroidInventoryScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: (repo) => repo.saveMedicine(ondansetron),
    });

    await user.click(await screen.findByRole('button', { name: /set count/i }));
    await user.type(screen.getByLabelText(/units added/i), '30');
    await user.click(screen.getByRole('button', { name: /log refill/i }));

    await waitFor(async () => {
      const adjustments = await db.inventoryAdjustments.toArray();
      expect(adjustments).toHaveLength(1);
      expect(adjustments[0]).toMatchObject({ medicineId: 'med-1', delta: 30, reason: 'initial' });
    });

    const tables = (await repository.pendingSync()).map((entry) => entry.table);
    expect(tables).toContain('inventoryItems');
    expect(tables).toContain('inventoryAdjustments');
  });

  it('adds a second refill to the ledger instead of replacing the first', async () => {
    const user = userEvent.setup();
    const { db } = await renderWithAndroidApp(<AndroidInventoryScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await repository.saveMedicine(ondansetron);
        await repository.saveInventoryItem({
          id: 'inv-1',
          medicineId: 'med-1',
          refillThreshold: 10,
          unitName: 'units',
          updatedAt: '',
          updatedByDeviceId: '',
          syncStatus: 'pending',
        });
        await repository.adjustInventory({ medicineId: 'med-1', delta: 20, reason: 'initial' });
      },
    });

    await user.click(await screen.findByRole('button', { name: /refill/i }));
    await user.type(screen.getByLabelText(/units added/i), '30');
    await user.click(screen.getByRole('button', { name: /log refill/i }));

    await waitFor(async () => {
      const total = (await db.inventoryAdjustments.toArray()).reduce(
        (sum, adjustment) => sum + adjustment.delta,
        0,
      );
      expect(total).toBe(50);
    });

    expect(await screen.findByText('50 units')).toBeInTheDocument();
  });

  it('flags low stock at or below the refill threshold', async () => {
    await renderWithAndroidApp(<AndroidInventoryScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await repository.saveMedicine(ondansetron);
        await repository.saveInventoryItem({
          id: 'inv-1',
          medicineId: 'med-1',
          refillThreshold: 10,
          unitName: 'pills',
          updatedAt: '',
          updatedByDeviceId: '',
          syncStatus: 'pending',
        });
        await repository.adjustInventory({ medicineId: 'med-1', delta: 10, reason: 'initial' });
      },
    });

    expect(await screen.findByText('Low stock')).toBeInTheDocument();
    expect(screen.getByText('10 pills')).toBeInTheDocument();
  });

  it('surfaces negative stock rather than clamping it to zero', async () => {
    // Negative stock means doses were logged that the recorded stock could not have covered —
    // a real bookkeeping error, and hiding it would hide the error too.
    await renderWithAndroidApp(<AndroidInventoryScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await repository.saveMedicine(ondansetron);
        await repository.saveInventoryItem({
          id: 'inv-1',
          medicineId: 'med-1',
          refillThreshold: 10,
          unitName: 'pills',
          updatedAt: '',
          updatedByDeviceId: '',
          syncStatus: 'pending',
        });
        await repository.adjustInventory({ medicineId: 'med-1', delta: 1, reason: 'initial' });
        await repository.recordDose({
          id: 'log-1',
          patientId: SINGLE_PATIENT_ID,
          medicineId: 'med-1',
          type: 'prn',
          status: 'taken',
          actualTime: '2026-06-15T10:00:00.000Z',
          quantityTaken: 3,
          loggedByUserId: 'Dad',
          loggedByDeviceId: 'other',
          syncStatus: 'synced',
        });
      },
    });

    expect(await screen.findByText('Check count')).toBeInTheDocument();
    expect(screen.getByText('-2 pills')).toBeInTheDocument();
  });

  it('decrements stock when a dose is recorded', async () => {
    await renderWithAndroidApp(<AndroidInventoryScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await repository.saveMedicine(ondansetron);
        await repository.saveInventoryItem({
          id: 'inv-1',
          medicineId: 'med-1',
          refillThreshold: 5,
          unitName: 'pills',
          updatedAt: '',
          updatedByDeviceId: '',
          syncStatus: 'pending',
        });
        await repository.adjustInventory({ medicineId: 'med-1', delta: 30, reason: 'initial' });
        await repository.recordDose({
          id: 'log-1',
          patientId: SINGLE_PATIENT_ID,
          medicineId: 'med-1',
          type: 'prn',
          status: 'taken',
          actualTime: '2026-06-15T10:00:00.000Z',
          quantityTaken: 2,
          loggedByUserId: 'Dad',
          loggedByDeviceId: 'other',
          syncStatus: 'synced',
        });
      },
    });

    expect(await screen.findByText('28 pills')).toBeInTheDocument();
    expect(screen.getByText('In stock')).toBeInTheDocument();
  });

  it('closes the refill dialog on cancel', async () => {
    const user = userEvent.setup();
    await renderWithAndroidApp(<AndroidInventoryScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: (repository) => repository.saveMedicine(ondansetron),
    });

    await user.click(await screen.findByRole('button', { name: /set count/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByLabelText(/units added/i)).not.toBeInTheDocument();
  });
});
