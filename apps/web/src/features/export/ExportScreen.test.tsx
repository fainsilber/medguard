import 'fake-indexeddb/auto';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import type { MedGuardRepository } from '../../db/repository.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { ExportScreen } from './ExportScreen.js';

const TIME_ZONE = 'UTC';

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:mock');
  URL.revokeObjectURL = vi.fn();
  window.print = vi.fn();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

async function seedOneDose(repository: MedGuardRepository) {
  await repository.saveMedicine(
    {
      id: 'medicine-1',
      patientId: 'patient-1',
      name: 'Ondansetron',
      strength: '4mg',
      form: 'pill',
      archived: false,
      updatedAt: '2026-06-01T00:00:00.000Z',
      updatedByDeviceId: 'seed',
      syncStatus: 'synced',
    },
    'CREATE',
  );
  await repository.recordDose({
    id: 'log-1',
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    type: 'prn',
    status: 'taken',
    actualTime: '2026-06-15T08:00:00.000Z',
    quantityTaken: 1,
    loggedByUserId: 'Mom',
    loggedByDeviceId: 'seed-device',
    syncStatus: 'synced',
  });
}

describe('ExportScreen', () => {
  it('shows an empty state and disables both export actions when nothing has been logged', async () => {
    await renderWithRepository(<ExportScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
    });

    expect(await screen.findByText('No doses logged yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Print summary' })).toBeDisabled();
  });

  it('lists a logged dose in the printable summary table', async () => {
    await renderWithRepository(<ExportScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: seedOneDose,
    });

    expect(await screen.findByText('Ondansetron 4mg')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '08:00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeEnabled();
  });

  it('triggers a CSV download with a filename and content type when clicked', async () => {
    const user = userEvent.setup();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await renderWithRepository(<ExportScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: seedOneDose,
    });

    await user.click(await screen.findByRole('button', { name: 'Download CSV' }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blobArg = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Blob;
    expect(blobArg.type).toBe('text/csv;charset=utf-8');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');
  });

  it('calls window.print for the printable summary', async () => {
    const user = userEvent.setup();
    await renderWithRepository(<ExportScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: seedOneDose,
    });

    await user.click(await screen.findByRole('button', { name: 'Print summary' }));
    expect(window.print).toHaveBeenCalledTimes(1);
  });

  it('excludes a superseded log but shows its correction, and surfaces an override reason', async () => {
    await renderWithRepository(<ExportScreen />, {
      clock: fixedClock('2026-06-15T12:00:00.000Z'),
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedOneDose(repository);
        await repository.correctDose('log-1', {
          id: 'log-2',
          patientId: 'patient-1',
          medicineId: 'medicine-1',
          type: 'prn',
          status: 'taken',
          actualTime: '2026-06-15T08:00:00.000Z',
          quantityTaken: 2,
          loggedByUserId: 'Mom',
          loggedByDeviceId: 'seed-device',
          notes: 'Actually gave two',
          syncStatus: 'synced',
        });
      },
    });

    expect(await screen.findByText('Actually gave two')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: '1' })).not.toBeInTheDocument();
  });
});
