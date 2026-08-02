/**
 * Measures whether a running timer survives the tab being backgrounded or the screen being
 * locked, and for how long — the "Background timer survival, iOS vs Android" probe item.
 *
 * A plain `setInterval` is deliberate here: the question this answers is precisely what the OS
 * does to an ordinary timer, so a Web Worker (which has its own, different suspension behavior)
 * would answer a different question. Ambient `Date.now()` is intentional for the same reason
 * this whole module lives outside the no-ambient-time-covered paths — it exists to measure real
 * wall-clock behavior on a real device, not to be a testable domain function.
 */
export interface TimerSurvivalResult {
  startedAtIso: string;
  tickCount: number;
  gapsMs: number[];
  maxGapMs: number;
  expectedIntervalMs: number;
}

export interface TimerSurvivalProbe {
  start(): void;
  /** Stops the timer and returns what was observed. Safe to call even if never started. */
  stop(): TimerSurvivalResult;
  isRunning(): boolean;
}

/**
 * Pure gap arithmetic, kept separate from the interval-driving code so it's directly testable.
 * A fake-timer test can't faithfully simulate a mobile OS suspending JS execution — advancing
 * virtual time always fires every interval tick on schedule — so the thing worth guaranteeing
 * by test is that gap detection is computed correctly from whatever tick sequence occurs, not
 * that a real suspension can be reproduced in a test environment. That part is what the real
 * device is for.
 */
export function computeGaps(ticks: number[]): { gapsMs: number[]; maxGapMs: number } {
  const gapsMs = ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? tick));
  return { gapsMs, maxGapMs: gapsMs.length > 0 ? Math.max(...gapsMs) : 0 };
}

export function createTimerSurvivalProbe(intervalMs = 5000): TimerSurvivalProbe {
  let ticks: number[] = [];
  let handle: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      ticks = [Date.now()];
      handle = setInterval(() => {
        ticks.push(Date.now());
      }, intervalMs);
    },

    stop() {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }

      const { gapsMs, maxGapMs } = computeGaps(ticks);

      return {
        startedAtIso: new Date(ticks[0] ?? Date.now()).toISOString(),
        tickCount: ticks.length,
        gapsMs,
        maxGapMs,
        expectedIntervalMs: intervalMs,
      };
    },

    isRunning() {
      return handle !== null;
    },
  };
}
