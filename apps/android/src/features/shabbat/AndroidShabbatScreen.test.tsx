import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import { fixedClock } from '@medguard/shared/testing';
import type { IntakeLog } from '@medguard/shared';
import { AndroidShabbatScreen } from './AndroidShabbatScreen.js';
import { renderWithAndroidApp } from '../../testUtils/renderWithAndroidApp.js';
import { medicine, schedule } from '../../testUtils/fixtures.js';

const TIME_ZONE = 'Asia/Jerusalem';
/** Sunday 2026-06-14 09:00 UTC — Motzei Shabbat, with Saturday's doses behind us. */
const clock = fixedClock('2026-06-14T09:00:00.000Z');

async function seedSchedule(repository: {
  saveMedicine: (m: ReturnType<typeof medicine>) => Promise<void>;
  saveSchedule: (s: ReturnType<typeof schedule>) => Promise<void>;
}) {
  await repository.saveMedicine(medicine({ id: 'med-1', name: 'Paracetamol', asNeeded: false }));
  await repository.saveSchedule(
    schedule({ id: 'sched-1', medicineId: 'med-1', timesOfDay: ['08:00'] }),
  );
}

describe('AndroidShabbatScreen', () => {
  it('lists doses that came due with nothing logged against them', async () => {
    await renderWithAndroidApp(<AndroidShabbatScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: seedSchedule,
    });

    // Three mornings inside the 72-hour window, all unlogged.
    await waitFor(() => {
      expect(screen.getAllByText('Paracetamol').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText(/tap to select/i).length).toBeGreaterThan(0);
  });

  it('omits an occurrence that already has a log', async () => {
    await renderWithAndroidApp(<AndroidShabbatScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await seedSchedule(repository);
        await repository.recordDose({
          id: 'log-1',
          patientId: SINGLE_PATIENT_ID,
          medicineId: 'med-1',
          scheduleId: 'sched-1',
          type: 'scheduled',
          status: 'taken',
          scheduledTime: '2026-06-13T05:00:00.000Z',
          actualTime: '2026-06-13T05:00:00.000Z',
          quantityTaken: 1,
          loggedByUserId: 'Dad',
          loggedByDeviceId: 'other',
          syncStatus: 'synced',
        });
      },
    });

    await waitFor(() => {
      expect(screen.getAllByText(/tap to select/i)).toHaveLength(2);
    });
  });

  it('reports nothing outstanding when every dose is accounted for', async () => {
    await renderWithAndroidApp(<AndroidShabbatScreen />, { clock, timeZone: TIME_ZONE });

    expect(await screen.findByText(/nothing outstanding/i)).toBeInTheDocument();
  });

  it('records a reconciled dose against its scheduled time, not the moment of reconciliation', async () => {
    // Stamping "now" would push every subsequent cooldown window hours late, and would leave the
    // Today view still showing the occurrence as never given.
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidShabbatScreen />, {
      clock,
      userId: 'Mom',
      timeZone: TIME_ZONE,
      seed: seedSchedule,
    });

    const cards = await screen.findAllByText(/tap to select/i);
    await user.click(cards[0]!);
    await user.click(screen.getByRole('button', { name: /confirm 1 dose$/i }));

    await waitFor(async () => {
      const payload = (await repository.pendingSync())
        .filter((entry) => entry.table === 'intakeLogs')
        .map((entry) => entry.payload as IntakeLog)[0];

      expect(payload).toBeDefined();
      expect(payload?.scheduleId).toBe('sched-1');
      expect(payload?.type).toBe('scheduled');
      expect(payload?.scheduledTime).toBe(payload?.actualTime);
      expect(payload?.notes).toBe('Motzei Shabbat reconciliation');
      expect(payload?.loggedByUserId).toBe('Mom');
    });
  });

  it('reconciles several doses at once and reports how many', async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidShabbatScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: seedSchedule,
    });

    const cards = await screen.findAllByText(/tap to select/i);
    await user.click(cards[0]!);
    await user.click(cards[1]!);
    await user.click(screen.getByRole('button', { name: /confirm 2 doses/i }));

    expect(await screen.findByText(/2 doses recorded and queued to sync/i)).toBeInTheDocument();

    const logs = (await repository.pendingSync()).filter((entry) => entry.table === 'intakeLogs');
    expect(logs).toHaveLength(2);
  });

  it('deselects a card that is tapped twice', async () => {
    const user = userEvent.setup();
    await renderWithAndroidApp(<AndroidShabbatScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: seedSchedule,
    });

    const cards = await screen.findAllByText(/tap to select/i);
    await user.click(cards[0]!);
    expect(screen.getByRole('button', { name: /confirm 1 dose$/i })).toBeInTheDocument();

    await user.click(screen.getByText('Selected'));
    expect(screen.queryByRole('button', { name: /confirm/i })).not.toBeInTheDocument();
  });

  it('describes the chime as foreground-only rather than implying a locked-screen alarm', async () => {
    await renderWithAndroidApp(<AndroidShabbatScreen />, { clock, timeZone: TIME_ZONE });

    expect(await screen.findByText(/foreground only/i)).toBeInTheDocument();
  });

  it('toggles the test chime on and off', async () => {
    const user = userEvent.setup();
    await renderWithAndroidApp(<AndroidShabbatScreen />, { clock, timeZone: TIME_ZONE });

    // jsdom has no Web Audio, so this exercises the silent-but-still-timed path.
    await user.click(await screen.findByRole('button', { name: /test 15s chime/i }));
    const stop = await screen.findByRole('button', { name: /stop chime/i });

    await user.click(stop);
    expect(await screen.findByRole('button', { name: /test 15s chime/i })).toBeInTheDocument();
  });
});
