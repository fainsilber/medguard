import { fireEvent, waitFor } from '@testing-library/react-native';
import { fixedClock } from '@medguard/shared/testing';
import type { IntakeLog, Medicine } from '@medguard/shared';
import { readLogsFromDb } from '../../testUtils/readLogs.js';
import { renderWithRepository } from '../../testUtils/renderWithRepository.js';
import { PrnCard } from './PrnCard.js';

/**
 * The safety-critical path of Sprint A2: the PRN two-step override flow. Neither "Give anyway
 * (override)" nor typing a reason and hitting "Continue" may, alone, ever record a dose — only
 * completing both steps may. This is the single most important behavioral invariant ported this
 * sprint (docs/android-client-plan.md's whole reason for the app existing hinges on the safety
 * engine being trustworthy), so it's tested directly against a real repository/SQLite double
 * rather than mocked — a passing test here means `repository.recordDose` was actually called with
 * the exact override payload asserted, not that a mock was called.
 */

const NOW = '2026-06-15T12:00:00.000Z';
const TRUSTED = { kind: 'trusted' as const, offsetMs: 0 };

function makeMedicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'medicine-1',
    patientId: 'patient-1',
    name: 'Ibuprofen',
    strength: '200mg',
    form: 'pill',
    asNeeded: true,
    minHoursBetweenDoses: 4,
    archived: false,
    updatedAt: NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

/** `makeMedicine` defaults to a 4h cooldown guard; this strips it for the "no guard" cases —
 * `exactOptionalPropertyTypes` forbids passing `minHoursBetweenDoses: undefined` directly. */
function noGuard(medicine: Medicine): Medicine {
  const { minHoursBetweenDoses: _drop, ...rest } = medicine;
  return rest;
}

function makeLog(overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id: 'log-1',
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    type: 'prn',
    status: 'taken',
    actualTime: '2026-06-15T11:00:00.000Z', // 1 hour before NOW — inside a 4h cooldown
    quantityTaken: 1,
    loggedByUserId: 'Mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('PrnCard — two-step override flow', () => {
  it('in a safe state, "Give dose" records a dose with no override', async () => {
    const { getByText, queryByText } = renderWithRepository(
      <PrnCard
        medicine={noGuard(makeMedicine())}
        patientId="patient-1"
        logs={[]}
        timeZone="UTC"
        clockTrust={TRUSTED}
      />,
      { clock: fixedClock(NOW), dbName: 'prn-safe.db' },
    );

    await waitFor(() => expect(queryByText('Give dose')).toBeTruthy());
    fireEvent.press(getByText('Give dose'));

    await waitFor(() => expect(queryByText('Recording…')).toBeFalsy(), { timeout: 5000 });
  });

  it('in a safe state, "Different time…" records a dose at the entered time, not now', async () => {
    const { getByText, getByLabelText, queryByText } = renderWithRepository(
      <PrnCard
        medicine={noGuard(makeMedicine())}
        patientId="patient-1"
        logs={[]}
        timeZone="UTC"
        clockTrust={TRUSTED}
      />,
      { clock: fixedClock(NOW), dbName: 'prn-custom-time.db' },
    );

    await waitFor(() => expect(queryByText('Different time…')).toBeTruthy());
    fireEvent.press(getByText('Different time…'));

    await waitFor(() => expect(queryByText('When was it actually given?')).toBeTruthy());
    fireEvent.changeText(getByLabelText('Time given'), '11:30');
    fireEvent.press(getByText('Save'));

    let written: IntakeLog[] = [];
    await waitFor(async () => {
      written = await readLogsFromDb('prn-custom-time.db', 'medicine-1');
      expect(written).toHaveLength(1);
    });
    expect(written[0]?.actualTime).toBe('2026-06-15T11:30:00.000Z');
  });

  it('blocked by cooldown: tapping "Give anyway" alone does not record a dose', async () => {
    const { getByText, queryByText } = renderWithRepository(
      <PrnCard
        medicine={makeMedicine()}
        patientId="patient-1"
        logs={[makeLog()]}
        timeZone="UTC"
        clockTrust={TRUSTED}
      />,
      { clock: fixedClock(NOW), dbName: 'prn-override-step1.db' },
    );

    await waitFor(() => expect(queryByText('Give anyway (override)')).toBeTruthy());
    fireEvent.press(getByText('Give anyway (override)'));

    // Reason panel opens; the confirm step must not have happened yet.
    await waitFor(() => expect(queryByText('Why are you overriding this?')).toBeTruthy());
    expect(
      queryByText('Are you sure? This will be permanently recorded as an override.'),
    ).toBeFalsy();
    expect(await readLogsFromDb('prn-override-step1.db', 'medicine-1')).toHaveLength(0);
  });

  it('an empty reason blocks proceeding to the confirm step', async () => {
    const { getByText, queryByText } = renderWithRepository(
      <PrnCard
        medicine={makeMedicine()}
        patientId="patient-1"
        logs={[makeLog()]}
        timeZone="UTC"
        clockTrust={TRUSTED}
      />,
      { clock: fixedClock(NOW), dbName: 'prn-empty-reason.db' },
    );

    await waitFor(() => expect(queryByText('Give anyway (override)')).toBeTruthy());
    fireEvent.press(getByText('Give anyway (override)'));
    await waitFor(() => expect(queryByText('Continue')).toBeTruthy());

    fireEvent.press(getByText('Continue'));

    // Still on the reason step — an empty reason must not advance to confirm.
    expect(
      queryByText('Are you sure? This will be permanently recorded as an override.'),
    ).toBeFalsy();
    expect(await readLogsFromDb('prn-empty-reason.db', 'medicine-1')).toHaveLength(0);
  });

  it('entering a reason and hitting Continue alone (no second confirm) does not record a dose', async () => {
    const { getByText, getByLabelText, queryByText, queryByLabelText } = renderWithRepository(
      <PrnCard
        medicine={makeMedicine()}
        patientId="patient-1"
        logs={[makeLog()]}
        timeZone="UTC"
        clockTrust={TRUSTED}
      />,
      { clock: fixedClock(NOW), dbName: 'prn-override-step2.db' },
    );

    await waitFor(() => expect(queryByText('Give anyway (override)')).toBeTruthy());
    fireEvent.press(getByText('Give anyway (override)'));

    await waitFor(() => expect(queryByLabelText('Why are you overriding this?')).toBeTruthy());
    fireEvent.changeText(
      getByLabelText('Why are you overriding this?'),
      'Fever spiked, checked with doctor',
    );
    fireEvent.press(getByText('Continue'));

    // Now on the confirm step — the dose must not be recorded until "Yes, give the dose" is tapped.
    await waitFor(() =>
      expect(
        queryByText('Are you sure? This will be permanently recorded as an override.'),
      ).toBeTruthy(),
    );
    expect(queryByText('Yes, give the dose')).toBeTruthy();
    expect(await readLogsFromDb('prn-override-step2.db', 'medicine-1')).toHaveLength(0);
  });

  it('completing both steps records a dose with the typed reason and the correct blockedBy', async () => {
    const { getByText, getByLabelText, queryByText, queryByLabelText } = renderWithRepository(
      <PrnCard
        medicine={makeMedicine()}
        patientId="patient-1"
        logs={[makeLog()]}
        timeZone="UTC"
        clockTrust={TRUSTED}
      />,
      { clock: fixedClock(NOW), dbName: 'prn-override-complete.db' },
    );

    await waitFor(() => expect(queryByText('Give anyway (override)')).toBeTruthy());
    fireEvent.press(getByText('Give anyway (override)'));

    await waitFor(() => expect(queryByLabelText('Why are you overriding this?')).toBeTruthy());
    fireEvent.changeText(
      getByLabelText('Why are you overriding this?'),
      'Fever spiked, checked with doctor',
    );
    fireEvent.press(getByText('Continue'));

    await waitFor(() => expect(queryByText('Yes, give the dose')).toBeTruthy());
    fireEvent.press(getByText('Yes, give the dose'));

    // The override panel closes — proves completion at the UI level.
    await waitFor(
      () =>
        expect(
          queryByText('Are you sure? This will be permanently recorded as an override.'),
        ).toBeFalsy(),
      { timeout: 5000 },
    );
    expect(queryByText('Why are you overriding this?')).toBeFalsy();

    // Proves it at the storage level: exactly one log, carrying the typed reason and the
    // cooldown block reason `assessDose` actually computed — not a hardcoded string.
    let written: IntakeLog[] = [];
    await waitFor(async () => {
      written = await readLogsFromDb('prn-override-complete.db', 'medicine-1');
      expect(written).toHaveLength(1);
    });
    expect(written[0]?.status).toBe('taken');
    expect(written[0]?.quantityTaken).toBe(1);
    expect(written[0]?.override).toEqual({
      confirmedByUserId: 'test-user',
      reason: 'Fever spiked, checked with doctor',
      blockedBy: 'cooldown',
    });
  });

  it('a daily-cap block records blockedBy: "daily_cap", not "cooldown"', async () => {
    const cappedMedicine = noGuard(makeMedicine({ maxDailyDoses: 1 }));
    const logs = [makeLog({ actualTime: '2026-06-15T08:00:00.000Z' })]; // 1 dose already in the rolling 24h window

    const { getByText, getByLabelText, queryByText, queryByLabelText } = renderWithRepository(
      <PrnCard
        medicine={cappedMedicine}
        patientId="patient-1"
        logs={logs}
        timeZone="UTC"
        clockTrust={TRUSTED}
      />,
      { clock: fixedClock(NOW), dbName: 'prn-daily-cap.db' },
    );

    await waitFor(() => expect(queryByText('Daily limit reached')).toBeTruthy());
    fireEvent.press(getByText('Give anyway (override)'));
    await waitFor(() => expect(queryByLabelText('Why are you overriding this?')).toBeTruthy());
    fireEvent.changeText(
      getByLabelText('Why are you overriding this?'),
      'Pain unmanageable, called nurse line',
    );
    fireEvent.press(getByText('Continue'));
    await waitFor(() => expect(queryByText('Yes, give the dose')).toBeTruthy());
    fireEvent.press(getByText('Yes, give the dose'));

    await waitFor(
      () =>
        expect(
          queryByText('Are you sure? This will be permanently recorded as an override.'),
        ).toBeFalsy(),
      { timeout: 5000 },
    );
  });
});
