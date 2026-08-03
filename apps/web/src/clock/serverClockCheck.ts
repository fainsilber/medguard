import { CLOCK_SKEW_TOLERANCE_MS } from '@medguard/shared';
import type { ClockTrust } from '@medguard/shared';

/**
 * Verifies this device's clock against the server's (delta D7).
 *
 * This closes the gap the local heuristic in localClockGuard.ts cannot: a clock that was *always*
 * wrong. That device never sees its own drift — nothing local disagrees with it — so only an
 * outside reference can catch it. It matters because a wrong clock silently defeats every PRN
 * cooldown: set a phone forward two hours and the app will believe the wait has elapsed.
 *
 * This is an impure edge, like localClockGuard.ts and packages/shared/src/runtime/ — it reads
 * ambient time and performs I/O, so it lives outside the no-ambient-time boundary rather than
 * pretending not to.
 */

/** Kept short: this gates a safety decision, so waiting a long time is worse than failing closed. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * How long a successful check is trusted before it must be repeated. A clock that gets changed
 * after a check would otherwise stay "trusted" indefinitely.
 */
export const CLOCK_CHECK_TTL_MS = 5 * 60_000;

export interface ServerClockCheck {
  trust: ClockTrust;
  checkedAtMs: number;
}

/**
 * Asks the server what time it is and compares.
 *
 * Half the round-trip is subtracted from the server's reading before comparing: the response was
 * generated partway through the request, so on a slow mobile connection the naive comparison would
 * report skew that is really just latency, and start blocking doses for no reason.
 *
 * Any failure — offline, timeout, a non-200, a malformed body — returns `unverified`, never
 * `trusted`. Failing closed is the whole point (safety invariant 3): an unreachable server must
 * not silently grant permission it never gave.
 */
export async function checkServerClock(apiBaseUrl: string): Promise<ClockTrust> {
  const startedMs = Date.now();

  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/time`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    });

    if (!response.ok) {
      return { kind: 'unverified' };
    }

    const body: unknown = await response.json();
    const serverNowMs = (body as { nowMs?: unknown }).nowMs;
    if (typeof serverNowMs !== 'number' || !Number.isFinite(serverNowMs)) {
      return { kind: 'unverified' };
    }

    const finishedMs = Date.now();
    const roundTripMs = finishedMs - startedMs;
    const offsetMs = finishedMs - (serverNowMs + roundTripMs / 2);

    if (Math.abs(offsetMs) > CLOCK_SKEW_TOLERANCE_MS) {
      return { kind: 'skewed', offsetMs };
    }
    return { kind: 'trusted', offsetMs };
  } catch {
    return { kind: 'unverified' };
  }
}
