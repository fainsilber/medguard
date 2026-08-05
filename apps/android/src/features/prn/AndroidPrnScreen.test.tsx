import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import { fixedClock } from '@medguard/shared/testing';
import type { IntakeLog } from '@medguard/shared';
import { AndroidPrnScreen } from './AndroidPrnScreen.js';
import { renderWithAndroidApp } from '../../testUtils/renderWithAndroidApp.js';
import { medicine } from '../../testUtils/fixtures.js';

/**
 * The screen this project exists to get right. Every test here drives a fake clock, because the
 * behaviour that matters — locked at 3h59m, safe at 4h01m — is only observable against a clock
 * you control.
 */

const NOW = '2026-06-15T12:00:00.000Z';
const clock = fixedClock(NOW);

function doseAt(actualTime: string, medicineId = 'med-1', id = `log-${actualTime}`): IntakeLog {
  return {
    id,
    patientId: SINGLE_PATIENT_ID,
    medicineId,
    type: 'prn',
    status: 'taken',
    actualTime,
    quantityTaken: 1,
    loggedByUserId: 'Dad',
    loggedByDeviceId: 'other-device',
    syncStatus: 'synced',
  };
}

const guardedMedicine = medicine({
  id: 'med-1',
  name: 'Ondansetron',
  asNeeded: true,
  minHoursBetweenDoses: 4,
  maxDailyDoses: 3,
});

describe('AndroidPrnScreen', () => {
  it('lists as-needed medicines and permits a dose when nothing blocks it', async () => {
    await renderWithAndroidApp(<AndroidPrnScreen />, {
      clock,
      timeZone: 'Asia/Jerusalem',
      seed: (repository) => repository.saveMedicine(guardedMedicine),
    });

    expect(await screen.findByText('Ondansetron')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /give prn dose/i })).toBeInTheDocument();
  });

  it('excludes scheduled and archived medicines', async () => {
    await renderWithAndroidApp(<AndroidPrnScreen />, {
      clock,
      timeZone: 'Asia/Jerusalem',
      seed: async (repository) => {
        await repository.saveMedicine(
          medicine({ id: 'med-2', name: 'Scheduled Only', asNeeded: false }),
        );
        await repository.saveMedicine(
          medicine({ id: 'med-3', name: 'Retired PRN', asNeeded: true, archived: true }),
        );
      },
    });

    expect(await screen.findByText(/no as-needed medicines configured/i)).toBeInTheDocument();
    expect(screen.queryByText('Scheduled Only')).not.toBeInTheDocument();
    expect(screen.queryByText('Retired PRN')).not.toBeInTheDocument();
  });

  it('locks the medicine while the cooldown is still running', async () => {
    // Last dose one hour ago against a four-hour minimum gap.
    await renderWithAndroidApp(<AndroidPrnScreen />, {
      clock,
      timeZone: 'Asia/Jerusalem',
      seed: async (repository) => {
        await repository.saveMedicine(guardedMedicine);
        await repository.recordDose(doseAt('2026-06-15T11:00:00.000Z'));
      },
    });

    expect(await screen.findByText('Locked')).toBeInTheDocument();
    expect(screen.getByText(/locked for 3 hrs/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /give prn dose/i })).not.toBeInTheDocument();
  });

  it('unlocks once the cooldown has elapsed', async () => {
    await renderWithAndroidApp(<AndroidPrnScreen />, {
      clock,
      timeZone: 'Asia/Jerusalem',
      seed: async (repository) => {
        await repository.saveMedicine(guardedMedicine);
        await repository.recordDose(doseAt('2026-06-15T07:59:00.000Z'));
      },
    });

    expect(await screen.findByRole('button', { name: /give prn dose/i })).toBeInTheDocument();
    expect(screen.getByText('Safe')).toBeInTheDocument();
  });

  it('caps the medicine once the rolling 24-hour limit is reached', async () => {
    await renderWithAndroidApp(<AndroidPrnScreen />, {
      clock,
      timeZone: 'Asia/Jerusalem',
      seed: async (repository) => {
        await repository.saveMedicine(
          medicine({ id: 'med-1', name: 'Ondansetron', maxDailyDoses: 3 }),
        );
        await repository.recordDose(doseAt('2026-06-14T13:00:00.000Z', 'med-1', 'a'));
        await repository.recordDose(doseAt('2026-06-14T20:00:00.000Z', 'med-1', 'b'));
        await repository.recordDose(doseAt('2026-06-15T02:00:00.000Z', 'med-1', 'c'));
      },
    });

    expect(await screen.findByText('Capped')).toBeInTheDocument();
    expect(screen.getByText(/3 of 3 doses used in the last 24 hours/i)).toBeInTheDocument();
  });

  it('records a permitted dose against the caregiver and this device', async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidPrnScreen />, {
      clock,
      userId: 'Mom',
      timeZone: 'Asia/Jerusalem',
      seed: (repository) => repository.saveMedicine(guardedMedicine),
    });

    await user.click(await screen.findByRole('button', { name: /give prn dose/i }));

    await waitFor(async () => {
      const queued = await repository.pendingSync();
      const logEntry = queued.find((entry) => entry.table === 'intakeLogs');
      expect(logEntry).toBeDefined();
      expect(logEntry?.payload).toMatchObject({
        medicineId: 'med-1',
        type: 'prn',
        status: 'taken',
        actualTime: NOW,
        loggedByUserId: 'Mom',
      });
    });
  });

  it('requires a reason before a blocked dose can be overridden', async () => {
    const user = userEvent.setup();

    await renderWithAndroidApp(<AndroidPrnScreen />, {
      clock,
      timeZone: 'Asia/Jerusalem',
      seed: async (repository) => {
        await repository.saveMedicine(guardedMedicine);
        await repository.recordDose(doseAt('2026-06-15T11:00:00.000Z'));
      },
    });

    await user.click(await screen.findByRole('button', { name: /override safety lock/i }));

    const confirm = screen.getByRole('button', { name: /confirm override/i });
    expect(confirm).toBeDisabled();

    await user.type(screen.getByLabelText(/override reason/i), 'Doctor instructed by phone');
    expect(confirm).toBeEnabled();
  });

  it('writes the override as a structured audit record, not a free-text note', async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidPrnScreen />, {
      clock,
      userId: 'Mom',
      timeZone: 'Asia/Jerusalem',
      seed: async (repository) => {
        await repository.saveMedicine(guardedMedicine);
        await repository.recordDose(doseAt('2026-06-15T11:00:00.000Z'));
      },
    });

    await user.click(await screen.findByRole('button', { name: /override safety lock/i }));
    await user.type(screen.getByLabelText(/override reason/i), 'Doctor instructed by phone');
    await user.click(screen.getByRole('button', { name: /confirm override/i }));

    await waitFor(async () => {
      const logs = await repository.pendingSync();
      const overrideLog = logs
        .map((entry) => entry.payload as IntakeLog)
        .find((payload) => payload.override !== undefined);

      expect(overrideLog?.override).toEqual({
        confirmedByUserId: 'Mom',
        reason: 'Doctor instructed by phone',
        // What the engine actually objected to, in the vocabulary the audit trail uses.
        blockedBy: 'cooldown',
      });
    });
  });

  it('closes the override dialog on cancel without recording anything', async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidPrnScreen />, {
      clock,
      timeZone: 'Asia/Jerusalem',
      seed: async (repository) => {
        await repository.saveMedicine(guardedMedicine);
        await repository.recordDose(doseAt('2026-06-15T11:00:00.000Z'));
      },
    });

    await user.click(await screen.findByRole('button', { name: /override safety lock/i }));
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByLabelText(/override reason/i)).not.toBeInTheDocument();
    // One entry: the seeded dose. Nothing new was written.
    expect((await repository.pendingSync()).filter((e) => e.table === 'intakeLogs')).toHaveLength(
      1,
    );
  });

  it('shows an unguarded PRN medicine as safe with no limits', async () => {
    await renderWithAndroidApp(<AndroidPrnScreen />, {
      clock,
      timeZone: 'Asia/Jerusalem',
      seed: (repository) =>
        repository.saveMedicine(medicine({ id: 'med-9', name: 'Saline', asNeeded: true })),
    });

    expect(await screen.findByText('Safe')).toBeInTheDocument();
    expect(screen.getByText(/max 24h: unlimited/i)).toBeInTheDocument();
  });
});
