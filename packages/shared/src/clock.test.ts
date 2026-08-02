import { describe, expect, it } from 'vitest';
import { CLOCK_SKEW_TOLERANCE_MS, fromIso, isClockTrusted, toIso } from './clock.js';
import type { ClockTrust } from './clock.js';
import { fixedClock, manualClock, sequentialIds } from './testing.js';

describe('ISO conversion', () => {
  it('round-trips an instant without losing milliseconds', () => {
    const iso = '2026-08-02T09:15:00.123Z';
    expect(toIso(fromIso(iso))).toBe(iso);
  });

  it('normalises a non-UTC offset to UTC', () => {
    // Israel in August is UTC+3.
    expect(toIso(fromIso('2026-08-02T12:15:00.000+03:00'))).toBe('2026-08-02T09:15:00.000Z');
  });

  it('throws on an unparseable instant rather than yielding an invalid date', () => {
    // A silently invalid timestamp inside a cooldown calculation is the failure mode
    // this guards against.
    expect(() => fromIso('not-a-date')).toThrow(RangeError);
    expect(() => fromIso('')).toThrow(RangeError);
  });
});

describe('manualClock', () => {
  it('does not move until advanced', () => {
    const clock = manualClock('2026-08-02T09:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-08-02T09:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-08-02T09:00:00.000Z');
  });

  it('advances by exact amounts, so boundary assertions are precise', () => {
    const clock = manualClock('2026-08-02T09:00:00.000Z');

    clock.advanceHours(4);
    expect(clock.nowIso()).toBe('2026-08-02T13:00:00.000Z');

    // One millisecond either side of a boundary is the shape of every cooldown test.
    clock.advanceMs(-0 + 1);
    expect(clock.nowMs()).toBe(fromIso('2026-08-02T13:00:00.001Z'));
  });

  it('refuses to run backwards via advanceMs', () => {
    const clock = manualClock('2026-08-02T09:00:00.000Z');
    expect(() => clock.advanceMs(-1)).toThrow(RangeError);
  });

  it('allows an explicit jump backwards, for clock-skew tests', () => {
    const clock = manualClock('2026-08-02T09:00:00.000Z');
    clock.setIso('2026-08-01T09:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-08-01T09:00:00.000Z');
  });
});

describe('fixedClock', () => {
  it('is frozen', () => {
    const clock = fixedClock('2026-08-02T09:00:00.000Z');
    expect(clock.nowMs()).toBe(clock.nowMs());
  });
});

describe('sequentialIds', () => {
  it('produces stable, readable ids', () => {
    const ids = sequentialIds('log');
    expect([ids.next(), ids.next(), ids.next()]).toEqual(['log-1', 'log-2', 'log-3']);
  });
});

describe('clock trust', () => {
  it('treats only a verified in-tolerance clock as trusted', () => {
    const cases: Array<[ClockTrust, boolean]> = [
      [{ kind: 'trusted', offsetMs: 0 }, true],
      [{ kind: 'unverified' }, false],
      [{ kind: 'skewed', offsetMs: CLOCK_SKEW_TOLERANCE_MS + 1 }, false],
    ];

    for (const [trust, expected] of cases) {
      expect(isClockTrusted(trust)).toBe(expected);
    }
  });
});
