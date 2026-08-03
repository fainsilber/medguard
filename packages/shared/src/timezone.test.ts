import { describe, expect, it, vi } from 'vitest';
import { fromIso, toIso } from './clock.js';
import {
  addLocalDays,
  formatLocalDate,
  formatLocalTime,
  localDayOfWeek,
  localDaysBetween,
  resolveLocal,
  zoneOffsetMs,
} from './timezone.js';

/**
 * DST transition instants below were read from the platform's own IANA database rather than
 * derived from the published rules, so the fixtures can't be wrong about the thing they exist
 * to test:
 *
 *   Asia/Jerusalem   2026-03-27T00:00Z  +2 → +3   (local 02:00 → 03:00, 02:00-02:59 never happens)
 *                    2026-10-24T23:00Z  +3 → +2   (local 02:00 → 01:00, 01:00-01:59 happens twice)
 *   America/New_York 2026-03-08T07:00Z  -5 → -4
 *                    2026-11-01T06:00Z  -4 → -5
 */
const JERUSALEM = 'Asia/Jerusalem';
const NEW_YORK = 'America/New_York';

describe('zoneOffsetMs', () => {
  it('reports the standard-time offset outside DST', () => {
    expect(zoneOffsetMs(JERUSALEM, fromIso('2026-01-15T12:00:00.000Z'))).toBe(2 * 3_600_000);
    expect(zoneOffsetMs(NEW_YORK, fromIso('2026-01-15T12:00:00.000Z'))).toBe(-5 * 3_600_000);
  });

  it('reports the daylight offset inside DST', () => {
    expect(zoneOffsetMs(JERUSALEM, fromIso('2026-07-15T12:00:00.000Z'))).toBe(3 * 3_600_000);
    expect(zoneOffsetMs(NEW_YORK, fromIso('2026-07-15T12:00:00.000Z'))).toBe(-4 * 3_600_000);
  });

  it('flips exactly at the transition instant, not before', () => {
    expect(zoneOffsetMs(JERUSALEM, fromIso('2026-03-26T23:59:59.999Z'))).toBe(2 * 3_600_000);
    expect(zoneOffsetMs(JERUSALEM, fromIso('2026-03-27T00:00:00.000Z'))).toBe(3 * 3_600_000);
  });
});

describe('resolveLocal — ordinary days', () => {
  it('resolves a winter morning dose', () => {
    const result = resolveLocal(JERUSALEM, '2026-01-15', '08:00');
    expect(result.kind).toBe('exact');
    expect(toIso(result.instantMs)).toBe('2026-01-15T06:00:00.000Z');
  });

  it('resolves a summer evening dose', () => {
    const result = resolveLocal(JERUSALEM, '2026-07-15', '20:00');
    expect(result.kind).toBe('exact');
    expect(toIso(result.instantMs)).toBe('2026-07-15T17:00:00.000Z');
  });

  it('round-trips back to the same wall clock reading', () => {
    for (const [date, time] of [
      ['2026-01-15', '08:00'],
      ['2026-07-15', '20:00'],
      ['2026-12-31', '23:59'],
      ['2026-06-01', '00:00'],
    ] as const) {
      const { instantMs } = resolveLocal(JERUSALEM, date, time);
      expect(formatLocalDate(JERUSALEM, instantMs)).toBe(date);
      expect(formatLocalTime(JERUSALEM, instantMs)).toBe(time);
    }
  });
});

describe('resolveLocal — spring forward (the dose must not be skipped)', () => {
  it('shifts a dose scheduled inside the gap rather than dropping it', () => {
    // 02:30 never happens on 2026-03-27 in Jerusalem.
    const result = resolveLocal(JERUSALEM, '2026-03-27', '02:30');

    expect(result.kind).toBe('shifted');
    // Fires at the equivalent point after the jump — 03:30, preserving the interval from the
    // previous dose rather than firing early at the transition boundary.
    expect(formatLocalTime(JERUSALEM, result.instantMs)).toBe('03:30');
    expect(formatLocalDate(JERUSALEM, result.instantMs)).toBe('2026-03-27');
    expect(toIso(result.instantMs)).toBe('2026-03-27T00:30:00.000Z');
  });

  it('reports the size of the gap it jumped', () => {
    const result = resolveLocal(JERUSALEM, '2026-03-27', '02:30');
    expect(result.kind === 'shifted' && result.gapMs).toBe(3_600_000);
  });

  it('treats the first instant of the gap as shifted too', () => {
    const result = resolveLocal(JERUSALEM, '2026-03-27', '02:00');
    expect(result.kind).toBe('shifted');
    expect(formatLocalTime(JERUSALEM, result.instantMs)).toBe('03:00');
  });

  it('resolves times either side of the gap exactly', () => {
    const before = resolveLocal(JERUSALEM, '2026-03-27', '01:59');
    const after = resolveLocal(JERUSALEM, '2026-03-27', '03:00');
    expect(before.kind).toBe('exact');
    expect(after.kind).toBe('exact');
  });

  it('behaves the same way in a western timezone', () => {
    const result = resolveLocal(NEW_YORK, '2026-03-08', '02:30');
    expect(result.kind).toBe('shifted');
    expect(formatLocalTime(NEW_YORK, result.instantMs)).toBe('03:30');
  });
});

describe('resolveLocal — fall back (the dose must not be doubled)', () => {
  it('takes the first of two identical wall-clock readings', () => {
    // 01:30 happens twice on 2026-10-25 in Jerusalem.
    const result = resolveLocal(JERUSALEM, '2026-10-25', '01:30');

    expect(result.kind).toBe('ambiguous');
    expect(toIso(result.instantMs)).toBe('2026-10-24T22:30:00.000Z');
  });

  it('reports the repeat it discarded, an hour later', () => {
    const result = resolveLocal(JERUSALEM, '2026-10-25', '01:30');

    expect(result.kind === 'ambiguous' && toIso(result.discardedInstantMs)).toBe(
      '2026-10-24T23:30:00.000Z',
    );
    // Both really are the same wall clock reading — that's what makes it ambiguous.
    expect(result.kind === 'ambiguous' && formatLocalTime(JERUSALEM, result.discardedInstantMs)).toBe(
      '01:30',
    );
  });

  it('keeps the chosen instant earlier than the discarded one', () => {
    const result = resolveLocal(JERUSALEM, '2026-10-25', '01:30');
    expect(result.kind === 'ambiguous' && result.instantMs < result.discardedInstantMs).toBe(true);
  });

  it('resolves times either side of the repeat exactly', () => {
    expect(resolveLocal(JERUSALEM, '2026-10-25', '00:30').kind).toBe('exact');
    expect(resolveLocal(JERUSALEM, '2026-10-25', '03:00').kind).toBe('exact');
  });

  it('behaves the same way in a western timezone', () => {
    const result = resolveLocal(NEW_YORK, '2026-11-01', '01:30');
    expect(result.kind).toBe('ambiguous');
  });
});

describe('addLocalDays', () => {
  it('advances within a month', () => {
    expect(addLocalDays('2026-03-10', 5)).toBe('2026-03-15');
  });

  it('crosses a month boundary', () => {
    expect(addLocalDays('2026-01-30', 3)).toBe('2026-02-02');
  });

  it('crosses a year boundary', () => {
    expect(addLocalDays('2026-12-30', 3)).toBe('2027-01-02');
  });

  it('handles a leap day', () => {
    expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addLocalDays('2028-02-29', 1)).toBe('2028-03-01');
  });

  it('skips 29 February in a non-leap year', () => {
    expect(addLocalDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('goes backwards', () => {
    expect(addLocalDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('is unaffected by DST — three days means three calendar days', () => {
    // Spanning the spring-forward transition, which loses an hour of real time.
    expect(addLocalDays('2026-03-26', 3)).toBe('2026-03-29');
  });
});

describe('localDaysBetween', () => {
  it('counts forwards', () => {
    expect(localDaysBetween('2026-03-01', '2026-03-15')).toBe(14);
  });

  it('counts backwards as negative', () => {
    expect(localDaysBetween('2026-03-15', '2026-03-01')).toBe(-14);
  });

  it('is zero for the same day', () => {
    expect(localDaysBetween('2026-03-01', '2026-03-01')).toBe(0);
  });

  it('counts whole days across a DST transition, not 23- or 25-hour spans', () => {
    expect(localDaysBetween('2026-03-26', '2026-03-28')).toBe(2);
    expect(localDaysBetween('2026-10-24', '2026-10-26')).toBe(2);
  });

  it('counts across a leap day', () => {
    expect(localDaysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });
});

describe('localDayOfWeek', () => {
  it('maps 0 to Sunday through 6 to Saturday', () => {
    expect(localDayOfWeek('2026-08-02')).toBe(0); // Sunday
    expect(localDayOfWeek('2026-08-03')).toBe(1);
    expect(localDayOfWeek('2026-08-08')).toBe(6); // Saturday
  });
});

describe('invalid input', () => {
  it('throws on an unknown timezone rather than silently using UTC', () => {
    expect(() => zoneOffsetMs('Not/AZone', 0)).toThrow();
  });

  it('fails loudly if the platform returns an incomplete date breakdown', () => {
    // Defensive path: every dose time in the app is derived from these parts, so a runtime that
    // silently omitted one would corrupt scheduling rather than error. Uses an unseen timezone
    // so the module's formatter cache doesn't serve a real formatter instead.
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      class {
        // Own property rather than a prototype method: vitest's class-mock wrapper doesn't
        // surface prototype methods on the constructed instance.
        formatToParts = () => [{ type: 'year', value: '2026' }];
      } as unknown as typeof Intl.DateTimeFormat,
    );

    try {
      expect(() => zoneOffsetMs('Etc/GMT+7', 0)).toThrow(/did not return a "month" part/);
    } finally {
      spy.mockRestore();
    }
  });
});
