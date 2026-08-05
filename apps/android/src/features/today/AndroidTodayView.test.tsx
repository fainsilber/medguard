import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import { fixedClock } from '@medguard/shared/testing';
import type { IntakeLog } from '@medguard/shared';
import { AndroidTodayView } from './AndroidTodayView.js';
import { renderWithAndroidApp } from '../../testUtils/renderWithAndroidApp.js';
import { medicine, schedule } from '../../testUtils/fixtures.js';

/**
 * `Asia/Jerusalem` throughout, seeded explicitly rather than taken from the host: every wall
 * clock time below is UTC+3, and a runner in another zone would otherwise read different times.
 */
const TIME_ZONE = 'Asia/Jerusalem';

/** 2026-06-15 12:00 UTC = 15:00 local. The 08:00 local dose is four hours overdue. */
const NOW = '2026-06-15T12:00:00.000Z';
const clock = fixedClock(NOW);

const paracetamol = medicine({ id: 'med-1', name: 'Paracetamol', asNeeded: false });
const morningSchedule = schedule({
  id: 'sched-1',
  medicineId: 'med-1',
  timesOfDay: ['08:00', '20:00'],
});

async function seedScheduled(repository: {
  saveMedicine: (m: ReturnType<typeof medicine>) => Promise<void>;
  saveSchedule: (s: ReturnType<typeof schedule>) => Promise<void>;
}) {
  await repository.saveMedicine(paracetamol);
  await repository.saveSchedule(morningSchedule);
}

describe('AndroidTodayView', () => {
  it('expands today’s occurrences in the household timezone', async () => {
    await renderWithAndroidApp(<AndroidTodayView />, {
      clock,
      timeZone: TIME_ZONE,
      seed: seedScheduled,
    });

    expect(await screen.findByText('08:00')).toBeInTheDocument();
    expect(screen.getByText('20:00')).toBeInTheDocument();
  });

  it('buckets a past dose as overdue and a future one as upcoming', async () => {
    await renderWithAndroidApp(<AndroidTodayView />, {
      clock,
      timeZone: TIME_ZONE,
      seed: seedScheduled,
    });

    expect(await screen.findByText('Overdue')).toBeInTheDocument();
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
  });

  it('says so plainly when nothing is scheduled', async () => {
    await renderWithAndroidApp(<AndroidTodayView />, { clock, timeZone: TIME_ZONE });

    expect(await screen.findByText(/no scheduled doses for today/i)).toBeInTheDocument();
  });

  it('records an on-time dose stamped with the occurrence’s due time, not now', async () => {
    // The difference matters: stamping "now" for a dose given at 08:00 would push every
    // subsequent cooldown window seven hours late.
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidTodayView />, {
      clock,
      userId: 'Mom',
      timeZone: TIME_ZONE,
      seed: seedScheduled,
    });

    await user.click((await screen.findAllByRole('button', { name: /mark taken/i }))[0]!);
    await user.click(screen.getByRole('button', { name: /on time/i }));

    await waitFor(async () => {
      const payloads = (await repository.pendingSync())
        .filter((entry) => entry.table === 'intakeLogs')
        .map((entry) => entry.payload as IntakeLog);

      expect(payloads[0]).toMatchObject({
        medicineId: 'med-1',
        scheduleId: 'sched-1',
        type: 'scheduled',
        status: 'taken',
        scheduledTime: '2026-06-15T05:00:00.000Z', // 08:00 local
        actualTime: '2026-06-15T05:00:00.000Z',
        loggedByUserId: 'Mom',
      });
    });
  });

  it('records a late dose at the current time when the caregiver says "just now"', async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidTodayView />, {
      clock,
      timeZone: TIME_ZONE,
      seed: seedScheduled,
    });

    await user.click((await screen.findAllByRole('button', { name: /mark taken/i }))[0]!);
    await user.click(screen.getByRole('button', { name: /just now/i }));

    await waitFor(async () => {
      const payload = (await repository.pendingSync())
        .filter((entry) => entry.table === 'intakeLogs')
        .map((entry) => entry.payload as IntakeLog)[0];

      expect(payload).toMatchObject({
        scheduledTime: '2026-06-15T05:00:00.000Z',
        actualTime: NOW,
      });
    });
  });

  it('marks an occurrence done once a log answers it', async () => {
    await renderWithAndroidApp(<AndroidTodayView />, {
      clock,
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedScheduled(repository);
        await repository.recordDose({
          id: 'log-1',
          patientId: SINGLE_PATIENT_ID,
          medicineId: 'med-1',
          scheduleId: 'sched-1',
          type: 'scheduled',
          status: 'taken',
          scheduledTime: '2026-06-15T05:00:00.000Z',
          actualTime: '2026-06-15T05:05:00.000Z',
          quantityTaken: 1,
          loggedByUserId: 'Dad',
          loggedByDeviceId: 'other',
          syncStatus: 'synced',
        });
      },
    });

    expect(await screen.findByText('Taken')).toBeInTheDocument();
    // Only the 20:00 occurrence is still actionable.
    expect(screen.getAllByRole('button', { name: /mark taken/i })).toHaveLength(1);
  });

  it('dismisses the prompt on cancel', async () => {
    const user = userEvent.setup();
    await renderWithAndroidApp(<AndroidTodayView />, {
      clock,
      timeZone: TIME_ZONE,
      seed: seedScheduled,
    });

    await user.click((await screen.findAllByRole('button', { name: /mark taken/i }))[0]!);
    expect(screen.getByRole('button', { name: /just now/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('button', { name: /just now/i })).not.toBeInTheDocument();
  });

  it('banners the most recent dose across every medicine', async () => {
    await renderWithAndroidApp(<AndroidTodayView />, {
      clock,
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedScheduled(repository);
        await repository.saveMedicine(medicine({ id: 'med-2', name: 'Ondansetron' }));
        await repository.recordDose({
          id: 'log-early',
          patientId: SINGLE_PATIENT_ID,
          medicineId: 'med-1',
          type: 'prn',
          status: 'taken',
          actualTime: '2026-06-15T06:00:00.000Z',
          quantityTaken: 1,
          loggedByUserId: 'Dad',
          loggedByDeviceId: 'other',
          syncStatus: 'synced',
        });
        await repository.recordDose({
          id: 'log-late',
          patientId: SINGLE_PATIENT_ID,
          medicineId: 'med-2',
          type: 'prn',
          status: 'taken',
          actualTime: '2026-06-15T09:00:00.000Z',
          quantityTaken: 1,
          loggedByUserId: 'Dad',
          loggedByDeviceId: 'other',
          syncStatus: 'synced',
        });
      },
    });

    expect(await screen.findByText('Last administered')).toBeInTheDocument();
    const banner = screen.getByText('Last administered').closest('div')?.parentElement;
    expect(banner?.textContent).toContain('Ondansetron');
  });

  it('does not banner a dose that a later correction superseded', async () => {
    await renderWithAndroidApp(<AndroidTodayView />, {
      clock,
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedScheduled(repository);
        await repository.recordDose({
          id: 'log-wrong',
          patientId: SINGLE_PATIENT_ID,
          medicineId: 'med-1',
          type: 'prn',
          status: 'taken',
          actualTime: '2026-06-15T09:00:00.000Z',
          quantityTaken: 1,
          loggedByUserId: 'Dad',
          loggedByDeviceId: 'other',
          syncStatus: 'synced',
        });
        await repository.recordDose({
          id: 'log-corrected',
          patientId: SINGLE_PATIENT_ID,
          medicineId: 'med-1',
          type: 'prn',
          status: 'skipped',
          actualTime: '2026-06-15T09:00:00.000Z',
          quantityTaken: 0,
          loggedByUserId: 'Dad',
          loggedByDeviceId: 'other',
          supersedesId: 'log-wrong',
          syncStatus: 'synced',
        });
      },
    });

    await screen.findByText(/today’s schedule/i);
    expect(screen.queryByText('Last administered')).not.toBeInTheDocument();
  });

  it('shows recent history once doses exist', async () => {
    await renderWithAndroidApp(<AndroidTodayView />, {
      clock,
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedScheduled(repository);
        await repository.recordDose({
          id: 'log-1',
          patientId: SINGLE_PATIENT_ID,
          medicineId: 'med-1',
          type: 'prn',
          status: 'taken',
          actualTime: '2026-06-15T09:00:00.000Z',
          quantityTaken: 1,
          loggedByUserId: 'Dad',
          loggedByDeviceId: 'other',
          syncStatus: 'synced',
        });
      },
    });

    expect(await screen.findByText(/logged by dad/i)).toBeInTheDocument();
  });

  it('reports an empty history rather than a blank section', async () => {
    await renderWithAndroidApp(<AndroidTodayView />, { clock, timeZone: TIME_ZONE });

    expect(await screen.findByText(/nothing logged yet/i)).toBeInTheDocument();
  });
});
