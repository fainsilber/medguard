import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SINGLE_PATIENT_ID, toIso } from '@medguard/shared';
import type { MedGuardRepository } from '@medguard/store';
import { renderWithRepository } from '../testUtils/renderWithRepository.js';
import { PushProvider } from './PushProvider.js';
import { recordPendingAction, webPendingActionSource } from './pendingActionStore.js';

/**
 * The end of the lock-screen path: a tap the service worker captured becomes a real dose the next
 * time the app runs.
 *
 * This is the web half of delta AD2. The worker records intent; nothing is a dose until this
 * provider hands it to the same repository transaction the Today screen uses.
 */

const MEDICINE_ID = '11111111-1111-4111-8111-111111111111';
const SCHEDULE_ID = '33333333-3333-4333-8333-333333333333';
const DUE_AT = '2026-08-09T08:00:00.000Z';
const OCCURRENCE = `${SCHEDULE_ID}:${DUE_AT}`;

async function seedSchedule(repository: MedGuardRepository): Promise<void> {
  await repository.saveMedicine({
    id: MEDICINE_ID,
    patientId: SINGLE_PATIENT_ID,
    name: 'Methotrexate',
    strength: '50mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    updatedAt: '1970-01-01T00:00:00.000Z',
    updatedByDeviceId: 'seed-device',
    syncStatus: 'synced',
  });
  await repository.saveSchedule({
    id: SCHEDULE_ID,
    medicineId: MEDICINE_ID,
    patientId: SINGLE_PATIENT_ID,
    frequencyType: 'daily',
    timesOfDay: ['08:00'],
    dosageQuantity: 2,
    startDate: '2026-08-01',
    active: true,
    updatedAt: '1970-01-01T00:00:00.000Z',
    updatedByDeviceId: 'seed-device',
    syncStatus: 'synced',
  });
}

beforeEach(async () => {
  // No household session and no notification permission: the registration half stays inert, so
  // these tests are about the drain and nothing else.
  localStorage.clear();
  vi.stubGlobal('Notification', { permission: 'default' });
  const existing = await webPendingActionSource.readPendingActions();
  await webPendingActionSource.ackPendingActions(existing.map((action) => action.id));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PushProvider', () => {
  it('turns a captured "Taken" tap into a dose, stamped with the tap time', async () => {
    await recordPendingAction({
      id: 'action-1',
      occurrenceKey: OCCURRENCE,
      action: 'taken',
      // Ten minutes after the dose was due — the caregiver saw it late and tapped on the lock
      // screen. This, not the moment the app happened to reopen, is what the log must say.
      tappedAtMs: Date.parse(DUE_AT) + 10 * 60_000,
    });

    let repository!: MedGuardRepository;
    await renderWithRepository(
      <PushProvider>
        <p>app</p>
      </PushProvider>,
      {
        timeZone: 'UTC',
        seed: async (seeded) => {
          repository = seeded;
          await seedSchedule(seeded);
        },
      },
    );

    expect(await screen.findByText('app')).toBeInTheDocument();

    await waitFor(async () => {
      const logs = await repository.logsForPatient(SINGLE_PATIENT_ID);
      expect(logs).toHaveLength(1);
    });

    const [log] = await repository.logsForPatient(SINGLE_PATIENT_ID);
    expect(log).toMatchObject({
      medicineId: MEDICINE_ID,
      scheduleId: SCHEDULE_ID,
      status: 'taken',
      scheduledTime: DUE_AT,
      actualTime: toIso(Date.parse(DUE_AT) + 10 * 60_000),
      quantityTaken: 2,
    });

    // Acknowledged only after the write committed, so a reload does not log it twice.
    await waitFor(async () => {
      expect(await webPendingActionSource.readPendingActions()).toEqual([]);
    });
  });

  it('turns a captured "Snooze" tap into a synced snooze record', async () => {
    await recordPendingAction({
      id: 'action-2',
      occurrenceKey: OCCURRENCE,
      action: 'snooze',
      tappedAtMs: Date.parse(DUE_AT),
    });

    let repository!: MedGuardRepository;
    await renderWithRepository(
      <PushProvider>
        <p>app</p>
      </PushProvider>,
      {
        timeZone: 'UTC',
        seed: async (seeded) => {
          repository = seeded;
          await seedSchedule(seeded);
        },
      },
    );

    await waitFor(async () => {
      expect(await repository.snoozesForOccurrence(OCCURRENCE)).toHaveLength(1);
    });

    const [snooze] = await repository.snoozesForOccurrence(OCCURRENCE);
    expect(snooze).toMatchObject({ occurrenceId: OCCURRENCE, count: 1 });
    expect(await repository.logsForPatient(SINGLE_PATIENT_ID)).toEqual([]);
  });

  it('drops a tap whose occurrence no longer exists rather than inventing a dose', async () => {
    await recordPendingAction({
      id: 'action-3',
      occurrenceKey: 'not-a-schedule:2026-08-09T08:00:00.000Z',
      action: 'taken',
      tappedAtMs: Date.parse(DUE_AT),
    });

    let repository!: MedGuardRepository;
    await renderWithRepository(
      <PushProvider>
        <p>app</p>
      </PushProvider>,
      {
        timeZone: 'UTC',
        seed: async (seeded) => {
          repository = seeded;
          await seedSchedule(seeded);
        },
      },
    );

    expect(await screen.findByText('app')).toBeInTheDocument();
    await waitFor(async () => {
      expect(await webPendingActionSource.readPendingActions()).toEqual([]);
    });
    expect(await repository.logsForPatient(SINGLE_PATIENT_ID)).toEqual([]);
  });
});
