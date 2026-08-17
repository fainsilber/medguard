import 'fake-indexeddb/auto';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import type { IntakeLog, Medicine } from '@medguard/shared';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { PrnCard } from './PrnCard.js';

const TIME_ZONE = 'UTC';

afterEach(() => {
  localStorage.clear();
});

function medicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'medicine-1',
    patientId: 'patient-1',
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: true,
    archived: false,
    updatedAt: '2026-06-01T00:00:00.000Z',
    updatedByDeviceId: 'seed',
    syncStatus: 'synced',
    ...overrides,
  };
}

function doseLog(overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id: 'log-1',
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    type: 'prn',
    status: 'taken',
    actualTime: '2026-06-15T08:00:00.000Z',
    quantityTaken: 1,
    loggedByUserId: 'Dad',
    loggedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('PrnCard', () => {
  it('shows Give dose when safe and records a PRN dose on click without throwing', async () => {
    const user = userEvent.setup();
    await renderWithRepository(
      <PrnCard medicine={medicine()} patientId="patient-1" logs={[]} timeZone={TIME_ZONE} />,
      {
        clock: fixedClock('2026-06-15T12:00:00.000Z'),
        timeZone: TIME_ZONE,
      },
    );

    expect(screen.getByText('🟢 Safe to take')).toBeInTheDocument();
    const giveButton = screen.getByRole('button', { name: 'Give dose' });
    await user.click(giveButton);

    // "Recording…" only clears once repository.recordDose's transaction has resolved, so this
    // proves the write completed rather than merely that the click handler ran.
    await screen.findByRole('button', { name: 'Give dose' });
    expect(giveButton).toBeEnabled();
  });

  it('lets a caregiver pick a different time than now when giving a dose', async () => {
    const user = userEvent.setup();
    await renderWithRepository(
      <PrnCard medicine={medicine()} patientId="patient-1" logs={[]} timeZone={TIME_ZONE} />,
      {
        clock: fixedClock('2026-06-15T12:00:00.000Z'),
        timeZone: TIME_ZONE,
      },
    );

    await user.click(screen.getByRole('button', { name: 'Different time…' }));
    expect(screen.getByLabelText('Time given')).toHaveValue('12:00');

    fireEvent.change(screen.getByLabelText('Time given'), { target: { value: '11:30' } });
    await user.click(screen.getByRole('button', { name: 'Save' }));

    // Back to the normal give-dose controls once the write completes.
    await screen.findByRole('button', { name: 'Give dose' });
    expect(screen.queryByLabelText('Time given')).not.toBeInTheDocument();
  });

  it('shows the last-administered banner with local time', async () => {
    await renderWithRepository(
      <PrnCard
        medicine={medicine()}
        patientId="patient-1"
        logs={[
          doseLog({
            actualTime: '2026-06-15T11:30:00.000Z',
            loggedByUserId: 'Mom',
            quantityTaken: 2,
          }),
        ]}
        timeZone={TIME_ZONE}
      />,
      { clock: fixedClock('2026-06-15T12:00:00.000Z'), timeZone: TIME_ZONE },
    );

    expect(await screen.findByText('Last given by Mom at 11:30 (2)')).toBeInTheDocument();
  });

  it('shows a live countdown while locked', async () => {
    await renderWithRepository(
      <PrnCard
        medicine={medicine({ minHoursBetweenDoses: 4 })}
        patientId="patient-1"
        logs={[doseLog({ actualTime: '2026-06-15T08:00:00.000Z' })]}
        timeZone={TIME_ZONE}
      />,
      { clock: fixedClock('2026-06-15T08:46:00.000Z'), timeZone: TIME_ZONE },
    );

    expect(await screen.findByText('🔴 Locked')).toBeInTheDocument();
    expect(screen.getByText('Locked: 3 hrs 14 mins remaining')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Give dose' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Give anyway (override)' })).toBeInTheDocument();
  });

  it('flips from locked to safe at the exact cooldown boundary', async () => {
    const guardedMedicine = medicine({ minHoursBetweenDoses: 4 });
    const logs = [doseLog({ actualTime: '2026-06-15T08:00:00.000Z' })];

    const beforeBoundary = await renderWithRepository(
      <PrnCard medicine={guardedMedicine} patientId="patient-1" logs={logs} timeZone={TIME_ZONE} />,
      { clock: fixedClock('2026-06-15T11:59:59.999Z'), timeZone: TIME_ZONE },
    );
    expect(await screen.findByText('🔴 Locked')).toBeInTheDocument();
    beforeBoundary.unmount();

    await renderWithRepository(
      <PrnCard medicine={guardedMedicine} patientId="patient-1" logs={logs} timeZone={TIME_ZONE} />,
      { clock: fixedClock('2026-06-15T12:00:00.000Z'), timeZone: TIME_ZONE },
    );
    expect(await screen.findByText('🟢 Safe to take')).toBeInTheDocument();
  });

  it('shows the daily cap as a distinct state from cooldown, with its own boundary', async () => {
    const cappedMedicine = medicine({ maxDailyDoses: 1 });
    // The rolling window is 24h from `actualTime`. 23h59m later, the earlier dose is still inside
    // it and blocks; 24h01m later it has aged out.
    const logs = [doseLog({ actualTime: '2026-06-15T08:00:00.000Z' })];

    const withinWindow = await renderWithRepository(
      <PrnCard medicine={cappedMedicine} patientId="patient-1" logs={logs} timeZone={TIME_ZONE} />,
      { clock: fixedClock('2026-06-16T07:59:00.000Z'), timeZone: TIME_ZONE },
    );
    expect(await screen.findByText('⚫ Daily limit reached')).toBeInTheDocument();
    expect(screen.getByText(/Daily limit reached \(1\/1 doses in 24h\)/)).toBeInTheDocument();
    withinWindow.unmount();

    await renderWithRepository(
      <PrnCard medicine={cappedMedicine} patientId="patient-1" logs={logs} timeZone={TIME_ZONE} />,
      { clock: fixedClock('2026-06-16T08:01:00.000Z'), timeZone: TIME_ZONE },
    );
    expect(await screen.findByText('🟢 Safe to take')).toBeInTheDocument();
  });

  it('blocks with a red, distinct message when the clock is unverified', async () => {
    await renderWithRepository(
      <PrnCard
        medicine={medicine({ minHoursBetweenDoses: 4 })}
        patientId="patient-1"
        logs={[doseLog({ actualTime: '2026-06-15T08:00:00.000Z' })]}
        timeZone={TIME_ZONE}
        clockTrust={{ kind: 'unverified' }}
      />,
      { clock: fixedClock('2026-06-15T12:00:00.000Z'), timeZone: TIME_ZONE },
    );

    expect(await screen.findByText('🔴 Clock unverified')).toBeInTheDocument();
    expect(screen.getByText(/clock could not be verified/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Give dose' })).not.toBeInTheDocument();
  });

  it('requires a reason and two separate confirmations before an override is recorded', async () => {
    const user = userEvent.setup();
    await renderWithRepository(
      <PrnCard
        medicine={medicine({ minHoursBetweenDoses: 4 })}
        patientId="patient-1"
        logs={[doseLog({ actualTime: '2026-06-15T08:00:00.000Z' })]}
        timeZone={TIME_ZONE}
      />,
      { clock: fixedClock('2026-06-15T09:00:00.000Z'), timeZone: TIME_ZONE },
    );

    await user.click(await screen.findByRole('button', { name: 'Give anyway (override)' }));

    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();

    await user.type(screen.getByRole('textbox'), 'Vomiting again, past due for relief');
    expect(continueButton).toBeEnabled();

    await user.click(continueButton);
    expect(
      screen.getByText('Are you sure? This will be permanently recorded as an override.'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Give anyway (override)' }),
    ).not.toBeInTheDocument();

    const confirmButton = screen.getByRole('button', { name: 'Yes, give the dose' });
    await user.click(confirmButton);

    // Successful override recording closes the flow back down.
    await screen.findByRole('button', { name: 'Give anyway (override)' });
    expect(screen.queryByText('Are you sure?', { exact: false })).not.toBeInTheDocument();
  });

  it('lets a caregiver cancel out of the override flow at either step', async () => {
    const user = userEvent.setup();
    await renderWithRepository(
      <PrnCard
        medicine={medicine({ minHoursBetweenDoses: 4 })}
        patientId="patient-1"
        logs={[doseLog({ actualTime: '2026-06-15T08:00:00.000Z' })]}
        timeZone={TIME_ZONE}
      />,
      { clock: fixedClock('2026-06-15T09:00:00.000Z'), timeZone: TIME_ZONE },
    );

    await user.click(await screen.findByRole('button', { name: 'Give anyway (override)' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByRole('button', { name: 'Give anyway (override)' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Give anyway (override)' }));
    await user.type(screen.getByRole('textbox'), 'reason');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(
      await screen.findByRole('button', { name: 'Give anyway (override)' }),
    ).toBeInTheDocument();
  });

  it('shows a patient name badge when given one, and none when not', async () => {
    const { unmount } = await renderWithRepository(
      <PrnCard medicine={medicine()} patientId="patient-1" patientName="Yoni" logs={[]} timeZone={TIME_ZONE} />,
      { clock: fixedClock('2026-06-15T12:00:00.000Z'), timeZone: TIME_ZONE },
    );
    expect(await screen.findByText('Yoni')).toBeInTheDocument();
    unmount();

    await renderWithRepository(
      <PrnCard medicine={medicine()} patientId="patient-1" logs={[]} timeZone={TIME_ZONE} />,
      { clock: fixedClock('2026-06-15T12:00:00.000Z'), timeZone: TIME_ZONE },
    );
    expect(await screen.findByText('Ondansetron')).toBeInTheDocument();
    expect(screen.queryByText('Yoni')).not.toBeInTheDocument();
  });
});
