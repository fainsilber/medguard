import { CLOCK_SKEW_TOLERANCE_MS } from '@medguard/shared';
import type { ClockTrust } from '@medguard/shared';

/**
 * A local, pre-server approximation of clock trust.
 *
 * The full safety guarantee needs a server: comparing this device's clock against a trusted
 * server time is the only way to catch a clock that has *always* been wrong — no NTP sync, a
 * wrong timezone applied at the OS level, and so on. That arrives with the real backend in
 * Sprint 3.
 *
 * Until then, this catches a narrower but still real and dangerous case: the clock changing
 * *while the app is running* — concretely, someone manually winding a phone's clock backward
 * mid-session so a PRN cooldown appears to have already elapsed. It works by comparing how much
 * wall-clock time (`Date.now()`) has passed against how much monotonic time (`performance.now()`,
 * which the user cannot change) has passed since the reference point below was captured. A
 * material mismatch means the wall clock moved on its own.
 *
 * What this cannot catch: a clock that was already wrong before this session ever started. That
 * gap is real, and is exactly why safety invariant 3 (fail closed, not open) will matter again
 * once Sprint 3's server check exists. This is a genuine, if partial, mitigation for now — not a
 * placeholder that does nothing.
 *
 * This is the impure edge for this one concern, the same role packages/shared/src/runtime/
 * plays for the Clock interface itself — which is why ambient `Date.now()` and `performance.now()`
 * are used directly here despite the no-ambient-time rule covering the rest of the app.
 */

const reference = {
  wallMs: Date.now(),
  monoMs: performance.now(),
};

/**
 * The current local clock trust, reflecting drift since this session started.
 *
 * Deliberately does *not* re-anchor the reference point when the app regains visibility: doing
 * so would erase evidence of exactly the tampering this exists to catch — change the clock while
 * the app is backgrounded, reopen it, and a reset reference would report a spotless "trusted".
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
