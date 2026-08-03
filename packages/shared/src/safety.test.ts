import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fromIso, toIso } from './clock.js';
import type { ClockTrust } from './clock.js';
import {
  ROLLING_WINDOW_MS,
  assessDose,
  blockReasonFor,
  dosesInRollingWindow,
  isDosePermitted,
} from './safety.js';
import { fixedClock } from './testing.js';
import { MS_PER_HOUR } from './timezone.js';
import type { IntakeLog, Medicine } from './types.js';

const NOW = '2026-06-15T12:00:00.000Z';
const NOW_MS = fromIso(NOW);
const TRUSTED: ClockTrust = { kind: 'trusted', offsetMs: 0 };

function makeMedicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'medicine-1',
    patientId: 'patient-1',
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    archived: false,
    updatedAt: NOW,
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

/** A dose administered `hoursAgo` before NOW. */
function doseAt(hoursAgo: number, overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id: `log-${hoursAgo}-${overrides.id ?? ''}`,
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    type: 'prn',
    status: 'taken',
    actualTime: toIso(NOW_MS - hoursAgo * MS_PER_HOUR),
    quantityTaken: 1,
    loggedByUserId: 'mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function assess(medicine: Medicine, logs: IntakeLog[], clockTrust: ClockTrust = TRUSTED) {
  return assessDose({ medicine, logs, clock: fixedClock(NOW), clockTrust });
}

describe('unguarded medicines', () => {
  it('are always safe, however recently dosed', () => {
    const result = assess(makeMedicine(), [doseAt(0.01)]);
    expect(result.state).toBe('safe');
    expect(isDosePermitted(result)).toBe(true);
  });

  it('still report the last dose, for the banner', () => {
    const result = assess(makeMedicine(), [doseAt(3, { loggedByUserId: 'dad', quantityTaken: 2 })]);
    expect(result.lastDose).toEqual({
      atIso: toIso(NOW_MS - 3 * MS_PER_HOUR),
      quantity: 2,
      byUserId: 'dad',
    });
  });

  it('report no last dose when there is no history', () => {
    expect(assess(makeMedicine(), []).lastDose).toBeUndefined();
  });
});

describe('cooldown', () => {
  const medicine = makeMedicine({ minHoursBetweenDoses: 4 });

  it('blocks one millisecond before the interval elapses', () => {
    const justUnder = toIso(NOW_MS - (4 * MS_PER_HOUR - 1));
    const result = assess(medicine, [doseAt(0, { actualTime: justUnder })]);

    expect(result.state).toBe('cooldown');
    expect(result.state === 'cooldown' && result.msRemaining).toBe(1);
  });

  it('permits exactly at the boundary — four hours means four hours', () => {
    const result = assess(medicine, [doseAt(4)]);
    expect(result.state).toBe('safe');
  });

  it('permits after the interval', () => {
    expect(assess(medicine, [doseAt(5)]).state).toBe('safe');
  });

  it('reports when the next dose becomes available', () => {
    const result = assess(medicine, [doseAt(1)]);
    expect(result.state === 'cooldown' && result.availableAtIso).toBe(
      toIso(NOW_MS + 3 * MS_PER_HOUR),
    );
  });

  it('measures from the most recent dose, not the first', () => {
    const result = assess(medicine, [doseAt(10), doseAt(1)]);
    expect(result.state === 'cooldown' && result.msRemaining).toBe(3 * MS_PER_HOUR);
  });

  it('is unblocked when there is no history at all', () => {
    expect(assess(medicine, []).state).toBe('safe');
  });

  it('counts a scheduled dose, not only PRN ones', () => {
    // A cap or interval limits what the patient receives, not how it was recorded.
    const result = assess(medicine, [doseAt(1, { type: 'scheduled', scheduleId: 'schedule-1' })]);
    expect(result.state).toBe('cooldown');
  });

  it('counts a dose that was itself given by override', () => {
    const overridden = doseAt(1, {
      override: { confirmedByUserId: 'mom', reason: 'vomiting', blockedBy: 'cooldown' },
    });
    expect(assess(medicine, [overridden]).state).toBe('cooldown');
  });
});

describe('rolling 24-hour cap', () => {
  const medicine = makeMedicine({ maxDailyDoses: 4 });

  it('permits below the cap', () => {
    expect(assess(medicine, [doseAt(1), doseAt(5), doseAt(9)]).state).toBe('safe');
  });

  it('blocks at the cap', () => {
    const result = assess(medicine, [doseAt(1), doseAt(5), doseAt(9), doseAt(13)]);
    expect(result.state).toBe('capped');
    expect(result.state === 'capped' && result.dosesInWindow).toBe(4);
  });

  it('is a rolling window, not a calendar day — a dose 23h59m ago still counts', () => {
    const nearlyOut = toIso(NOW_MS - (ROLLING_WINDOW_MS - 60_000));
    const result = assess(medicine, [
      doseAt(0, { id: 'a', actualTime: nearlyOut }),
      doseAt(1),
      doseAt(2),
      doseAt(3),
    ]);
    expect(result.state).toBe('capped');
  });

  it('a dose 24h01m ago has aged out of the window', () => {
    const justOut = toIso(NOW_MS - (ROLLING_WINDOW_MS + 60_000));
    const result = assess(medicine, [
      doseAt(0, { id: 'a', actualTime: justOut }),
      doseAt(1),
      doseAt(2),
      doseAt(3),
    ]);
    expect(result.state).toBe('safe');
  });

  it('unblocks when the oldest dose in the window ages out', () => {
    const result = assess(medicine, [doseAt(20), doseAt(5), doseAt(3), doseAt(1)]);
    // The 20-hours-ago dose leaves the window in another 4 hours.
    expect(result.state === 'capped' && result.availableAtIso).toBe(
      toIso(NOW_MS - 20 * MS_PER_HOUR + ROLLING_WINDOW_MS),
    );
  });

  it('handles being over the cap after an override, not just exactly at it', () => {
    // Five doses against a cap of four — legitimately reachable via override.
    const result = assess(medicine, [doseAt(20), doseAt(19), doseAt(5), doseAt(3), doseAt(1)]);
    expect(result.state === 'capped' && result.dosesInWindow).toBe(5);
    // Two must age out before there is room, so the binding dose is the 19-hours-ago one.
    expect(result.state === 'capped' && result.availableAtIso).toBe(
      toIso(NOW_MS - 19 * MS_PER_HOUR + ROLLING_WINDOW_MS),
    );
  });

  it('a cap of one behaves like a 24-hour interval', () => {
    const once = makeMedicine({ maxDailyDoses: 1 });
    expect(assess(once, [doseAt(23)]).state).toBe('capped');
    expect(assess(once, [doseAt(25)]).state).toBe('safe');
  });

  it('treats a corrupt non-positive cap as no cap rather than an absolute block', () => {
    // Unreachable through the schema, which requires a positive integer. If it ever occurs,
    // inventing a limit the caregiver never set would withhold a needed dose.
    const corrupt = makeMedicine({ maxDailyDoses: 0 });
    expect(assess(corrupt, [doseAt(1), doseAt(2)]).state).toBe('safe');
  });
});

describe('when both guards bind', () => {
  const medicine = makeMedicine({ minHoursBetweenDoses: 4, maxDailyDoses: 4 });

  it('reports the cap when it clears later than the cooldown', () => {
    // Cooldown clears in 3h; the cap not for another 20.
    const result = assess(medicine, [doseAt(4), doseAt(3), doseAt(2), doseAt(1)]);
    expect(result.state).toBe('capped');
  });

  it('reports the cooldown when it clears later than the cap', () => {
    // Only two doses, so the cap is not reached; the recent dose still blocks.
    const result = assess(medicine, [doseAt(23), doseAt(0.5)]);
    expect(result.state).toBe('cooldown');
  });

  it('is safe only when neither binds', () => {
    expect(assess(medicine, [doseAt(23), doseAt(22)]).state).toBe('safe');
  });
});

describe('untrusted clock — fail closed (invariant 3)', () => {
  const guarded = makeMedicine({ minHoursBetweenDoses: 4 });

  it('blocks a guarded medicine when the clock has never been verified', () => {
    const result = assess(guarded, [], { kind: 'unverified' });
    expect(result.state).toBe('untrusted_clock');
    expect(isDosePermitted(result)).toBe(false);
  });

  it('blocks a guarded medicine when the clock is known to be skewed', () => {
    const result = assess(guarded, [], { kind: 'skewed', offsetMs: 10 * MS_PER_HOUR });
    expect(result.state).toBe('untrusted_clock');
  });

  it('blocks even when the history alone would look safe', () => {
    // An unverifiable clock means an elapsed cooldown cannot be proven, not that it elapsed.
    expect(assess(guarded, [doseAt(100)], { kind: 'unverified' }).state).toBe('untrusted_clock');
  });

  it('still reports the last dose so the banner stays useful', () => {
    const result = assess(guarded, [doseAt(2)], { kind: 'unverified' });
    expect(result.lastDose?.atIso).toBe(toIso(NOW_MS - 2 * MS_PER_HOUR));
  });

  it('does not block a medicine with no guard configured', () => {
    // Nothing time-based is being enforced, so there is nothing the clock can invalidate.
    // Blocking here would be noise, and noise is what trains people to tap through real warnings.
    expect(assess(makeMedicine(), [doseAt(1)], { kind: 'unverified' }).state).toBe('safe');
  });

  it('applies to a cap-only medicine too', () => {
    const capped = makeMedicine({ maxDailyDoses: 4 });
    expect(assess(capped, [], { kind: 'unverified' }).state).toBe('untrusted_clock');
  });
});

describe('which logs count', () => {
  const medicine = makeMedicine({ minHoursBetweenDoses: 4 });

  it('ignores a dose that a later correction superseded', () => {
    const mistake = doseAt(1, { id: 'mistake' });
    const correction = doseAt(10, { id: 'correction', supersedesId: 'mistake' });

    // The recent dose was corrected to ten hours ago, so nothing blocks now.
    expect(assess(medicine, [mistake, correction]).state).toBe('safe');
  });

  it('follows a chain of corrections to the tip', () => {
    const first = doseAt(10, { id: 'first' });
    const second = doseAt(9, { id: 'second', supersedesId: 'first' });
    const third = doseAt(1, { id: 'third', supersedesId: 'second' });

    const result = assess(medicine, [first, second, third]);
    expect(result.state).toBe('cooldown');
    expect(result.lastDose?.atIso).toBe(toIso(NOW_MS - 1 * MS_PER_HOUR));
  });

  it('ignores skipped and missed doses — nothing was administered', () => {
    const logs = [
      doseAt(1, { id: 'skipped', status: 'skipped' }),
      doseAt(1, { id: 'missed', status: 'missed' }),
      doseAt(1, { id: 'pending', status: 'pending_shabbat' }),
    ];
    expect(assess(medicine, logs).state).toBe('safe');
  });

  it('ignores doses of a different medicine', () => {
    expect(assess(medicine, [doseAt(1, { medicineId: 'other' })]).state).toBe('safe');
  });

  it('counts a future-dated dose rather than letting clock skew free up capacity', () => {
    const future = toIso(NOW_MS + 30 * 60_000);
    const result = assess(medicine, [doseAt(0, { actualTime: future })]);
    expect(result.state).toBe('cooldown');
  });
});

describe('dosesInRollingWindow', () => {
  it('returns the window oldest first', () => {
    const window = dosesInRollingWindow([doseAt(1), doseAt(5), doseAt(3)], 'medicine-1', NOW_MS);
    expect(window.map((log) => log.actualTime)).toEqual([
      toIso(NOW_MS - 5 * MS_PER_HOUR),
      toIso(NOW_MS - 3 * MS_PER_HOUR),
      toIso(NOW_MS - 1 * MS_PER_HOUR),
    ]);
  });

  it('accepts a custom window', () => {
    const window = dosesInRollingWindow([doseAt(1), doseAt(5)], 'medicine-1', NOW_MS, 2 * MS_PER_HOUR);
    expect(window).toHaveLength(1);
  });
});

describe('blockReasonFor', () => {
  it('maps each verdict onto the override audit vocabulary', () => {
    const guarded = makeMedicine({ minHoursBetweenDoses: 4, maxDailyDoses: 2 });

    expect(blockReasonFor(assess(guarded, []))).toBeUndefined();
    expect(blockReasonFor(assess(guarded, [doseAt(1)]))).toBe('cooldown');
    expect(blockReasonFor(assess(guarded, [doseAt(20), doseAt(19)]))).toBe('daily_cap');
    expect(blockReasonFor(assess(guarded, [], { kind: 'unverified' }))).toBe('untrusted_clock');
  });
});

// ---------------------------------------------------------------------------
// Safety invariants — properties that must hold for *any* history, not just the
// examples above. These are the spec; the cases above are illustrations of it.
// ---------------------------------------------------------------------------

/** Doses at arbitrary times within the last ~30 hours. */
const doseHistory = fc.array(fc.double({ min: 0, max: 30, noNaN: true }), { maxLength: 12 });

describe('safety invariants (property-based)', () => {
  it('never reports safe while a dose sits inside the cooldown', () => {
    fc.assert(
      fc.property(doseHistory, fc.integer({ min: 1, max: 12 }), (hoursAgoList, cooldownHours) => {
        const medicine = makeMedicine({ minHoursBetweenDoses: cooldownHours });
        const logs = hoursAgoList.map((hoursAgo, index) => doseAt(hoursAgo, { id: `p${index}` }));
        const result = assess(medicine, logs);

        if (result.state !== 'safe') return true;

        // Nothing may have been administered more recently than the cooldown allows.
        return logs.every(
          (log) => NOW_MS - fromIso(log.actualTime) >= cooldownHours * MS_PER_HOUR,
        );
      }),
    );
  });

  it('never reports safe while the rolling window is at or over the cap', () => {
    fc.assert(
      fc.property(doseHistory, fc.integer({ min: 1, max: 6 }), (hoursAgoList, maxDailyDoses) => {
        const medicine = makeMedicine({ maxDailyDoses });
        const logs = hoursAgoList.map((hoursAgo, index) => doseAt(hoursAgo, { id: `p${index}` }));
        const result = assess(medicine, logs);

        if (result.state !== 'safe') return true;
        return dosesInRollingWindow(logs, medicine.id, NOW_MS).length < maxDailyDoses;
      }),
    );
  });

  it('always reports a strictly future availability when it blocks', () => {
    fc.assert(
      fc.property(
        doseHistory,
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 6 }),
        (hoursAgoList, cooldownHours, maxDailyDoses) => {
          const medicine = makeMedicine({ minHoursBetweenDoses: cooldownHours, maxDailyDoses });
          const logs = hoursAgoList.map((hoursAgo, index) => doseAt(hoursAgo, { id: `p${index}` }));
          const result = assess(medicine, logs);

          if (result.state !== 'cooldown' && result.state !== 'capped') return true;
          // A countdown that is zero or negative would render as an unlock that never comes.
          return result.msRemaining > 0 && fromIso(result.availableAtIso) > NOW_MS;
        },
      ),
    );
  });

  it('never blocks an unguarded medicine, whatever its history', () => {
    fc.assert(
      fc.property(doseHistory, (hoursAgoList) => {
        const logs = hoursAgoList.map((hoursAgo, index) => doseAt(hoursAgo, { id: `p${index}` }));
        return assess(makeMedicine(), logs).state === 'safe';
      }),
    );
  });

  it('always blocks a guarded medicine when the clock is untrusted', () => {
    fc.assert(
      fc.property(
        doseHistory,
        fc.constantFrom<ClockTrust>({ kind: 'unverified' }, { kind: 'skewed', offsetMs: 1 }),
        (hoursAgoList, trust) => {
          const medicine = makeMedicine({ minHoursBetweenDoses: 4 });
          const logs = hoursAgoList.map((hoursAgo, index) => doseAt(hoursAgo, { id: `p${index}` }));
          return assess(medicine, logs, trust).state === 'untrusted_clock';
        },
      ),
    );
  });
});
