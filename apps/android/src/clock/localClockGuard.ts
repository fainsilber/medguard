import { CLOCK_SKEW_TOLERANCE_MS } from '@medguard/shared';
import type { ClockTrust } from '@medguard/shared';

/**
 * Android port of `apps/web/src/clock/localClockGuard.ts`.
 *
 * **Decision: reused near-verbatim, no RN-specific replacement needed.** The only two primitives
 * this depends on are `Date.now()` (the wall clock, which a caregiver *can* change by winding the
 * device's clock) and `performance.now()` (a monotonic clock, which they cannot). Both are
 * available, unchanged, under React Native:
 *
 * - `Date.now()` is plain JS, unaffected by platform.
 * - `performance.now()` is installed as a global by React Native's own core bootstrap
 *   (`node_modules/react-native/Libraries/Core/setUpPerformance.js`, run via `InitializeCore`
 *   before any application code, on-device and under Jest alike) — backed by a native monotonic
 *   counter when available, falling back to a `Date.now()`-derived stand-in only in
 *   configurations without it. Either way it is not settable from JS, which is the property this
 *   guard actually depends on.
 *
 * Web's version also doesn't touch `performance.timeOrigin` or any other browser-only surface, so
 * there was no browser-only API to route around in the first place — this is a straight port, not
 * an approximation.
 *
 * See `apps/web/src/clock/localClockGuard.ts` for the full rationale on what this can and cannot
 * catch: a clock changed *during* this session, not one that was already wrong before the app
 * launched. That gap is exactly why `PrnCard`/`PrnScreen` accept an injected `clockTrust` prop —
 * so a future server round-trip (Sprint 3) can be plugged in without this file changing.
 */

const reference = {
  wallMs: Date.now(),
  monoMs: performance.now(),
};

/**
 * The current local clock trust, reflecting drift since this module was first loaded (i.e. since
 * this session started). Deliberately does not re-anchor when the app regains foreground — see
 * the web version's doc comment for why that would erase the exact tampering this exists to
 * catch.
 */
export function getLocalClockTrust(): ClockTrust {
  const wallElapsedMs = Date.now() - reference.wallMs;
  const monoElapsedMs = performance.now() - reference.monoMs;
  const driftMs = wallElapsedMs - monoElapsedMs;

  if (Math.abs(driftMs) > CLOCK_SKEW_TOLERANCE_MS) {
    return { kind: 'skewed', offsetMs: driftMs };
  }
  return { kind: 'trusted', offsetMs: driftMs };
}
