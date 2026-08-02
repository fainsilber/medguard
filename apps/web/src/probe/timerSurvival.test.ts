import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeGaps, createTimerSurvivalProbe } from './timerSurvival.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createTimerSurvivalProbe', () => {
  it('records evenly-spaced ticks when nothing suspends the timer', () => {
    const probe = createTimerSurvivalProbe(5000);
    probe.start();

    vi.advanceTimersByTime(20_000); // 4 ticks at 5s

    const result = probe.stop();
    expect(result.tickCount).toBe(5); // the initial tick plus 4 interval ticks
    expect(result.maxGapMs).toBe(5000);
    expect(result.gapsMs).toEqual([5000, 5000, 5000, 5000]);
  });

  it('is safe to stop without ever starting', () => {
    const probe = createTimerSurvivalProbe();
    const result = probe.stop();

    expect(result.tickCount).toBe(0);
    expect(result.maxGapMs).toBe(0);
    expect(result.gapsMs).toEqual([]);
  });

  it('stops ticking once stopped', () => {
    const probe = createTimerSurvivalProbe(5000);
    probe.start();
    vi.advanceTimersByTime(5000);
    const first = probe.stop();

    vi.advanceTimersByTime(20_000);
    const second = probe.stop();

    expect(second.tickCount).toBe(first.tickCount);
  });

  it('reports whether it is currently running', () => {
    const probe = createTimerSurvivalProbe();
    expect(probe.isRunning()).toBe(false);
    probe.start();
    expect(probe.isRunning()).toBe(true);
    probe.stop();
    expect(probe.isRunning()).toBe(false);
  });
});

describe('computeGaps', () => {
  it('returns no gaps for a single tick', () => {
    expect(computeGaps([1000])).toEqual({ gapsMs: [], maxGapMs: 0 });
  });

  it('returns no gaps for an empty sequence', () => {
    expect(computeGaps([])).toEqual({ gapsMs: [], maxGapMs: 0 });
  });

  it('computes evenly-spaced gaps', () => {
    expect(computeGaps([0, 5000, 10_000, 15_000])).toEqual({
      gapsMs: [5000, 5000, 5000],
      maxGapMs: 5000,
    });
  });

  it('flags a suspension as a large gap — the actual evidence this probe exists to collect', () => {
    // The scenario a real device produces: ticks recorded right up to the phone locking, a
    // long silence while the OS suspends JS, then ticks resuming once reopened.
    const ticks = [0, 5000, 10_000, 130_000, 135_000];
    expect(computeGaps(ticks)).toEqual({
      gapsMs: [5000, 5000, 120_000, 5000],
      maxGapMs: 120_000,
    });
  });
});
