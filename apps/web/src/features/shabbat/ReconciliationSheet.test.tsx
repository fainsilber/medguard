import 'fake-indexeddb/auto';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { SINGLE_PATIENT_ID, computeQuantity } from '@medguard/shared';
import { fixedClock } from '@medguard/shared/testing';
import type { Medicine, Schedule, ShabbatWindow } from '@medguard/shared';
import type { MedGuardRepository, Store } from '@medguard/store';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { ReconciliationSheet } from './ReconciliationSheet.js';

/**
 * The sheet is where the halachic deferral is repaid: nothing was recorded during Shabbat, so
 * everything has to be recordable afterwards — including the doses whose alert never fired, and
 * including an as-needed dose that broke a cooldown at the time it was given.
 */

const JERUSALEM = 'Asia/Jerusalem';
/** Sunday morning, after a Shabbat that ran Friday 19:03 to Saturday 20:01 local. */
const NOW = '2026-08-16T06:00:00.000Z';
const WINDOW_START = '2026-08-14T16:03:00.000Z';
const WINDOW_END = '2026-08-15T17:01:00.000Z';

afterEach(() => {
  localStorage.clear();
});

function makeWindow(): ShabbatWindow {
  return {
    id: `shabbat:${WINDOW_START}`,
    patientId: SINGLE_PATIENT_ID,
    kind: 'shabbat',
    label: 'Shabbat',
    startsAt: WINDOW_START,
    endsAt: WINDOW_END,
    generatedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedByDeviceId: 'server',
    syncStatus: 'synced',
  };
}

function makeMedicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'medicine-1',
    patientId: SINGLE_PATIENT_ID,
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced',
    ...overrides,
  };
}

/** 09:00 and 21:00 Jerusalem, so the window above holds the Friday 21:00 and Saturday 09:00 doses. */
function makeSchedule(): Schedule {
  return {
    id: 'schedule-1',
    medicineId: 'medicine-1',
    patientId: SINGLE_PATIENT_ID,
    frequencyType: 'daily',
    timesOfDay: ['09:00', '21:00'],
    dosageQuantity: 2,
    startDate: '2026-01-01',
    active: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced',
  };
}

async function putWindow(store: Store) {
  await store.transaction(['shabbatWindows'], (tx) => tx.put('shabbatWindows', makeWindow()));
}

/** A household with the window, a twice-daily schedule and some stock. */
async function seedHousehold(repository: MedGuardRepository, store: Store) {
  await repository.saveMedicine(makeMedicine(), 'CREATE');
  await repository.saveSchedule(makeSchedule(), 'CREATE');
  await repository.adjustInventory({ medicineId: 'medicine-1', delta: 20, reason: 'initial' });
  await putWindow(store);
}

describe('ReconciliationSheet', () => {
  it('asks about every dose from the window, including ones with no placeholder log', async () => {
    await renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: seedHousehold,
    });

    expect(await screen.findByText(/2 scheduled doses from Shabbat/)).toBeInTheDocument();
    expect(screen.getAllByText('Ondansetron')).toHaveLength(2);
  });

  it('records them all as given at their scheduled times, and moves stock once each', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;

    await renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (seedRepository, store) => {
        repository = seedRepository;
        await seedHousehold(seedRepository, store);
      },
    });

    await user.click(await screen.findByRole('button', { name: 'All given as scheduled' }));

    const logs = await repository!.logsForMedicine('medicine-1');
    expect(logs).toHaveLength(2);
    expect(logs.every((log) => log.status === 'taken')).toBe(true);
    // Recorded at the time each dose was due, not at the moment they were confirmed.
    expect(logs.map((log) => log.actualTime).sort()).toEqual(
      logs.map((log) => log.scheduledTime).sort(),
    );

    // 20 − 2 − 2: the stock that has been waiting since candle lighting.
    expect(computeQuantity(await repository!.adjustmentsForMedicine('medicine-1'))).toBe(16);
  });

  it('supersedes the placeholder the server wrote, rather than editing it', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;

    await renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (seedRepository, store) => {
        repository = seedRepository;
        await seedHousehold(seedRepository, store);
        await seedRepository.recordDose({
          id: 'pending-1',
          patientId: SINGLE_PATIENT_ID,
          medicineId: 'medicine-1',
          scheduleId: 'schedule-1',
          type: 'scheduled',
          status: 'pending_shabbat',
          scheduledTime: '2026-08-14T18:00:00.000Z',
          actualTime: '2026-08-14T18:00:00.000Z',
          quantityTaken: 0,
          loggedByUserId: 'system',
          loggedByDeviceId: 'system',
          syncStatus: 'synced',
        });
      },
    });

    await user.click(await screen.findByRole('button', { name: 'All given as scheduled' }));

    const logs = await repository!.logsForMedicine('medicine-1');
    const answer = logs.find((log) => log.supersedesId === 'pending-1');
    expect(answer?.status).toBe('taken');
    // The placeholder is still there — a correction appends, never edits.
    expect(logs.find((log) => log.id === 'pending-1')?.status).toBe('pending_shabbat');
  });

  it('records a dose that was not given as skipped, moving no stock', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;

    await renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (seedRepository, store) => {
        repository = seedRepository;
        await seedHousehold(seedRepository, store);
      },
    });

    const notGiven = await screen.findAllByRole('button', { name: 'Not given' });
    await user.click(notGiven[0]!);
    await user.click(screen.getByRole('button', { name: 'Record these answers' }));

    const logs = await repository!.logsForMedicine('medicine-1');
    expect(logs.filter((log) => log.status === 'skipped')).toHaveLength(1);
    // One dose given out of two: 20 − 2.
    expect(computeQuantity(await repository!.adjustmentsForMedicine('medicine-1'))).toBe(18);
  });

  it('takes a corrected time for a dose given late', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;

    await renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (seedRepository, store) => {
        repository = seedRepository;
        await seedHousehold(seedRepository, store);
      },
    });

    const timeInputs = await screen.findAllByLabelText(/Time given — Ondansetron/);
    await user.clear(timeInputs[0]!);
    await user.type(timeInputs[0]!, '22:30');
    await user.click(screen.getByRole('button', { name: 'Record these answers' }));

    const logs = await repository!.logsForMedicine('medicine-1');
    const late = logs.find((log) => log.scheduledTime === '2026-08-14T18:00:00.000Z');
    // 22:30 Jerusalem on the Friday the dose was due — not 22:30 on the day it was confirmed.
    expect(late?.actualTime).toBe('2026-08-14T19:30:00.000Z');
  });

  it('says so when there is nothing left to reconcile', async () => {
    await renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (repository) => {
        await repository.saveMedicine(makeMedicine(), 'CREATE');
      },
    });

    expect(
      await screen.findByText(/Every dose from Shabbat has been accounted for/),
    ).toBeInTheDocument();
  });
});

describe('retroactive PRN entry', () => {
  const PRN = makeMedicine({
    id: 'medicine-prn',
    name: 'Ondansetron PRN',
    asNeeded: true,
    minHoursBetweenDoses: 6,
  });

  it('records a dose given during Shabbat at the time it was given', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;

    await renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (seedRepository, store) => {
        repository = seedRepository;
        await seedRepository.saveMedicine(PRN, 'CREATE');
        await putWindow(store);
      },
    });

    await user.selectOptions(
      await screen.findByLabelText('Medicine given as needed'),
      'medicine-prn',
    );
    await user.clear(screen.getByLabelText('Date given'));
    await user.type(screen.getByLabelText('Date given'), '2026-08-15');
    await user.type(screen.getByLabelText('Time given as needed'), '14:00');
    await user.click(screen.getByRole('button', { name: 'Record this dose' }));

    const logs = await repository!.logsForMedicine('medicine-prn');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: 'prn', status: 'taken' });
    // 14:00 Jerusalem on the Saturday, not the Sunday morning it was typed in.
    expect(logs[0]!.actualTime).toBe('2026-08-15T11:00:00.000Z');
  });

  it('asks for a reason when the dose broke the cooldown at the time it was given', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;

    await renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (seedRepository, store) => {
        repository = seedRepository;
        await seedRepository.saveMedicine(PRN, 'CREATE');
        await putWindow(store);
        await seedRepository.recordDose({
          id: 'earlier',
          patientId: SINGLE_PATIENT_ID,
          medicineId: 'medicine-prn',
          type: 'prn',
          status: 'taken',
          actualTime: '2026-08-15T10:00:00.000Z',
          quantityTaken: 1,
          loggedByUserId: 'mom',
          loggedByDeviceId: 'seed',
          syncStatus: 'synced',
        });
      },
    });

    await user.selectOptions(
      await screen.findByLabelText('Medicine given as needed'),
      'medicine-prn',
    );
    await user.clear(screen.getByLabelText('Date given'));
    await user.type(screen.getByLabelText('Date given'), '2026-08-15');
    // Two hours after the earlier dose, inside a six-hour cooldown — judged as of then, not now.
    await user.type(screen.getByLabelText('Time given as needed'), '15:00');
    await user.click(screen.getByRole('button', { name: 'Record this dose' }));

    expect(await screen.findByText(/inside the safety limit/)).toBeInTheDocument();
    expect(await repository!.logsForMedicine('medicine-prn')).toHaveLength(1);

    await user.type(screen.getByLabelText('Why this dose was given'), 'Vomited the first dose');
    await user.click(screen.getByRole('button', { name: 'Record it with this reason' }));

    // The dose happened, so the record takes it — with the reason attached, never silently.
    const logs = await repository!.logsForMedicine('medicine-prn');
    expect(logs).toHaveLength(2);
    expect(logs.find((log) => log.id !== 'earlier')?.override).toMatchObject({
      blockedBy: 'cooldown',
      reason: 'Vomited the first dose',
    });
  });
});

describe('multi-patient', () => {
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

  it('badges each scheduled-dose item with the patient it belongs to', async () => {
    await renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (repository, store) => {
        await repository.savePatient(makePatient('yoni', 'Yoni', 0), 'CREATE');
        await repository.savePatient(makePatient('dad', 'Dad', 1), 'CREATE');
        await repository.saveMedicine(makeMedicine({ id: 'medicine-yoni' }), 'CREATE');
        await repository.saveSchedule(
          { ...makeSchedule(), id: 'schedule-yoni', medicineId: 'medicine-yoni', patientId: 'yoni' },
          'CREATE',
        );
        await putWindow(store);
      },
    });

    await screen.findByText(/scheduled doses from Shabbat/);
    expect(screen.getAllByText('Yoni').length).toBeGreaterThan(0);
  });

  it('asks which patient a retroactive PRN dose is for, when the medicine is shared', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;
    const sharedPrn = makeMedicine({
      id: 'medicine-shared-prn',
      name: 'Paracetamol PRN',
      asNeeded: true,
      minHoursBetweenDoses: 6,
    });

    await renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (seedRepository, store) => {
        repository = seedRepository;
        await seedRepository.savePatient(makePatient('yoni', 'Yoni', 0), 'CREATE');
        await seedRepository.savePatient(makePatient('dad', 'Dad', 1), 'CREATE');
        await seedRepository.saveMedicine(sharedPrn, 'CREATE');
        await seedRepository.assignMedicine('medicine-shared-prn', 'yoni');
        await seedRepository.assignMedicine('medicine-shared-prn', 'dad');
        await putWindow(store);
      },
    });

    await user.selectOptions(
      await screen.findByLabelText('Medicine given as needed'),
      'medicine-shared-prn',
    );
    const patientPicker = screen.getByLabelText('Patient given as needed');
    expect(Array.from(patientPicker.querySelectorAll('option')).map((o) => o.textContent)).toEqual([
      'Choose…',
      'Yoni',
      'Dad',
    ]);

    await user.selectOptions(patientPicker, 'dad');
    await user.clear(screen.getByLabelText('Date given'));
    await user.type(screen.getByLabelText('Date given'), '2026-08-15');
    await user.type(screen.getByLabelText('Time given as needed'), '14:00');
    await user.click(screen.getByRole('button', { name: 'Record this dose' }));

    const logs = await repository!.logsForMedicine('medicine-shared-prn');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ patientId: 'dad', status: 'taken' });
  });

  it('does not ask, and uses the sole assigned patient, for a private PRN medicine', async () => {
    const user = userEvent.setup();
    let repository: MedGuardRepository | undefined;
    const privatePrn = makeMedicine({
      id: 'medicine-private-prn',
      name: 'Ibuprofen PRN',
      asNeeded: true,
    });

    await renderWithRepository(<ReconciliationSheet />, {
      clock: fixedClock(NOW),
      timeZone: JERUSALEM,
      seed: async (seedRepository, store) => {
        repository = seedRepository;
        await seedRepository.savePatient(makePatient('yoni', 'Yoni', 0), 'CREATE');
        await seedRepository.saveMedicine(privatePrn, 'CREATE');
        await seedRepository.assignMedicine('medicine-private-prn', 'yoni');
        await putWindow(store);
      },
    });

    await user.selectOptions(
      await screen.findByLabelText('Medicine given as needed'),
      'medicine-private-prn',
    );
    expect(screen.queryByLabelText('Patient given as needed')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('Date given'));
    await user.type(screen.getByLabelText('Date given'), '2026-08-15');
    await user.type(screen.getByLabelText('Time given as needed'), '14:00');
    await user.click(screen.getByRole('button', { name: 'Record this dose' }));

    const logs = await repository!.logsForMedicine('medicine-private-prn');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ patientId: 'yoni', status: 'taken' });
  });
});
