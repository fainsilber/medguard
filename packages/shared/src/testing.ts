/**
 * Test doubles for the injected dependencies.
 *
 * Imported as `@medguard/shared/testing` so they never reach a production bundle.
 */
import { fromIso, toIso } from './clock.js';
import type { Clock, EpochMs, IdGenerator, IsoInstant } from './clock.js';

export interface ManualClock extends Clock {
  /** Move time forward. Negative values are rejected — time does not run backwards in tests. */
  advanceMs(ms: number): void;
  advanceMinutes(minutes: number): void;
  advanceHours(hours: number): void;
  /** Jump to a specific instant, forwards or backwards. For deliberately testing clock skew. */
  setIso(iso: IsoInstant): void;
}

/**
 * A clock you drive by hand. The backbone of every cooldown, cap and escalation test:
 * advance to one millisecond before a boundary, assert LOCKED; advance one more, assert GREEN.
 */
export function manualClock(startIso: IsoInstant): ManualClock {
  let current: EpochMs = fromIso(startIso);

  return {
    nowMs: () => current,
    nowIso: () => toIso(current),
    advanceMs(ms: number) {
      if (ms < 0) {
        throw new RangeError(`advanceMs expects a non-negative value, got ${ms}. Use setIso to move backwards.`);
      }
      current += ms;
    },
    advanceMinutes(minutes: number) {
      this.advanceMs(minutes * 60_000);
    },
    advanceHours(hours: number) {
      this.advanceMs(hours * 3_600_000);
    },
    setIso(iso: IsoInstant) {
      current = fromIso(iso);
    },
  };
}

/** A clock frozen at a single instant. */
export function fixedClock(iso: IsoInstant): Clock {
  const ms = fromIso(iso);
  return { nowMs: () => ms, nowIso: () => toIso(ms) };
}

/**
 * Deterministic ids, so fixtures stay stable and snapshot diffs stay readable.
 * Produces `${prefix}-1`, `${prefix}-2`, ...
 */
export function sequentialIds(prefix = 'id'): IdGenerator {
  let n = 0;
  return {
    next: () => `${prefix}-${++n}`,
  };
}
