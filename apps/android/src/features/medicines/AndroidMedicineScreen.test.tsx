import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import type { Medicine, Schedule } from '@medguard/shared';
import { AndroidMedicineScreen } from './AndroidMedicineScreen.js';
import { renderWithAndroidApp } from '../../testUtils/renderWithAndroidApp.js';
import { medicine, schedule } from '../../testUtils/fixtures.js';

const TIME_ZONE = 'Asia/Jerusalem';
/** 22:30 UTC on the 14th is already the 15th locally — the case a UTC date slice gets wrong. */
const clock = fixedClock('2026-06-14T22:30:00.000Z');

async function fillBasics(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /add medicine/i }));
  await user.type(screen.getByLabelText(/medicine name/i), 'Ondansetron');
  await user.type(screen.getByLabelText(/strength/i), '4mg');
}

describe('AndroidMedicineScreen', () => {
  it('invites a first medicine when none exist', async () => {
    await renderWithAndroidApp(<AndroidMedicineScreen />, { clock, timeZone: TIME_ZONE });

    expect(await screen.findByText(/no medicines configured yet/i)).toBeInTheDocument();
  });

  it('refuses to save without a name and a strength', async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidMedicineScreen />, {
      clock,
      timeZone: TIME_ZONE,
    });

    await user.click(await screen.findByRole('button', { name: /add medicine/i }));
    await user.click(screen.getByRole('button', { name: /save medicine/i }));

    expect(screen.getByRole('alert')).toHaveTextContent(/name and strength/i);
    expect(await repository.pendingSyncCount()).toBe(1); // only the seeded household settings
  });

  it('saves a PRN medicine with its safety guards', async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidMedicineScreen />, {
      clock,
      timeZone: TIME_ZONE,
    });

    await fillBasics(user);
    await user.type(screen.getByLabelText(/min cooldown/i), '4');
    await user.type(screen.getByLabelText(/max doses/i), '3');
    await user.click(screen.getByRole('button', { name: /save medicine/i }));

    await waitFor(async () => {
      const saved = (await repository.pendingSync())
        .filter((entry) => entry.table === 'medicines')
        .map((entry) => entry.payload as Medicine)[0];

      expect(saved).toMatchObject({
        name: 'Ondansetron',
        strength: '4mg',
        form: 'pill',
        asNeeded: true,
        archived: false,
        minHoursBetweenDoses: 4,
        maxDailyDoses: 3,
      });
    });
  });

  it('treats a blank or nonsensical guard as "not configured" rather than as zero', async () => {
    // A cooldown of 0 or NaN reaching the safety engine would be corrupt data; leaving the field
    // empty must mean the guard simply is not set.
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidMedicineScreen />, {
      clock,
      timeZone: TIME_ZONE,
    });

    await fillBasics(user);
    await user.type(screen.getByLabelText(/min cooldown/i), '0');
    await user.click(screen.getByRole('button', { name: /save medicine/i }));

    await waitFor(async () => {
      const saved = (await repository.pendingSync())
        .filter((entry) => entry.table === 'medicines')
        .map((entry) => entry.payload as Medicine)[0];

      expect(saved).toBeDefined();
      expect(saved).not.toHaveProperty('minHoursBetweenDoses');
      expect(saved).not.toHaveProperty('maxDailyDoses');
    });
  });

  it('creates a daily schedule for a scheduled medicine, dated in the household timezone', async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidMedicineScreen />, {
      clock,
      timeZone: TIME_ZONE,
    });

    await fillBasics(user);
    await user.click(screen.getByLabelText(/as needed/i));
    await user.clear(screen.getByLabelText(/scheduled time/i));
    await user.type(screen.getByLabelText(/scheduled time/i), '08:00');
    await user.click(screen.getByRole('button', { name: /save medicine/i }));

    await waitFor(async () => {
      const saved = (await repository.pendingSync())
        .filter((entry) => entry.table === 'schedules')
        .map((entry) => entry.payload as Schedule)[0];

      expect(saved).toMatchObject({
        frequencyType: 'daily',
        timesOfDay: ['08:00'],
        dosageQuantity: 1,
        active: true,
        // 22:30 UTC on the 14th is 01:30 local on the 15th. A UTC slice would say the 14th.
        startDate: '2026-06-15',
      });
    });
  });

  it('does not carry PRN guards onto a scheduled medicine', async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidMedicineScreen />, {
      clock,
      timeZone: TIME_ZONE,
    });

    await fillBasics(user);
    await user.type(screen.getByLabelText(/min cooldown/i), '4');
    await user.click(screen.getByLabelText(/as needed/i)); // switch to scheduled
    await user.click(screen.getByRole('button', { name: /save medicine/i }));

    await waitFor(async () => {
      const saved = (await repository.pendingSync())
        .filter((entry) => entry.table === 'medicines')
        .map((entry) => entry.payload as Medicine)[0];

      expect(saved?.asNeeded).toBe(false);
      expect(saved).not.toHaveProperty('minHoursBetweenDoses');
    });
  });

  it('records the medicine form the caregiver chose', async () => {
    const user = userEvent.setup();
    const { repository } = await renderWithAndroidApp(<AndroidMedicineScreen />, {
      clock,
      timeZone: TIME_ZONE,
    });

    await fillBasics(user);
    await user.selectOptions(screen.getByLabelText(/^form$/i), 'liquid');
    await user.click(screen.getByRole('button', { name: /save medicine/i }));

    await waitFor(async () => {
      const saved = (await repository.pendingSync())
        .filter((entry) => entry.table === 'medicines')
        .map((entry) => entry.payload as Medicine)[0];
      expect(saved?.form).toBe('liquid');
    });
  });

  it('closes and clears the form after a save', async () => {
    const user = userEvent.setup();
    await renderWithAndroidApp(<AndroidMedicineScreen />, { clock, timeZone: TIME_ZONE });

    await fillBasics(user);
    await user.click(screen.getByRole('button', { name: /save medicine/i }));

    await waitFor(() => {
      expect(screen.queryByLabelText(/medicine name/i)).not.toBeInTheDocument();
    });
  });

  it('cancels out of the form without saving', async () => {
    const user = userEvent.setup();
    await renderWithAndroidApp(<AndroidMedicineScreen />, { clock, timeZone: TIME_ZONE });

    await user.click(await screen.findByRole('button', { name: /add medicine/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByLabelText(/medicine name/i)).not.toBeInTheDocument();
  });

  it('lists existing medicines with their guards and schedule', async () => {
    await renderWithAndroidApp(<AndroidMedicineScreen />, {
      clock,
      timeZone: TIME_ZONE,
      seed: async (repository) => {
        await repository.saveMedicine(
          medicine({ id: 'med-1', name: 'Ondansetron', minHoursBetweenDoses: 6, maxDailyDoses: 4 }),
        );
        await repository.saveMedicine(
          medicine({ id: 'med-2', name: 'Paracetamol', asNeeded: false }),
        );
        await repository.saveSchedule(
          schedule({ id: 'sched-1', medicineId: 'med-2', timesOfDay: ['08:00', '20:00'] }),
        );
      },
    });

    expect(await screen.findByText('Ondansetron')).toBeInTheDocument();
    expect(screen.getByText('Min gap: 6h')).toBeInTheDocument();
    expect(screen.getByText('Max daily: 4')).toBeInTheDocument();
    expect(screen.getByText('Daily at 08:00, 20:00')).toBeInTheDocument();
    expect(screen.getByText('PRN')).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
  });
});
