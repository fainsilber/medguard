import { useEffect, useState } from 'react';
import { getLocalClockTrust } from '@medguard/shared';
import type { ClockTrust } from '@medguard/shared';
import { CLOCK_CHECK_TTL_MS, checkServerClock } from './serverClockCheck.js';

/**
 * The clock trust the PRN safety screen consults, combining both available checks.
 *
 * The two catch different failures and neither subsumes the other:
 *
 * - The **server** check catches a clock that has always been wrong. The device cannot detect that
 *   about itself; only an outside reference can.
 * - The **local** monotonic check catches a clock changed *during* this session, which a server
 *   check performed minutes ago would still be reporting as fine.
 *
 * So the answer is the more pessimistic of the two. Trusting either one alone would leave a real
 * way to get a green light for a dose that is not actually safe.
 */

/** Re-checks a little more often than the result expires, so trust rarely lapses mid-use. */
const REFRESH_INTERVAL_MS = CLOCK_CHECK_TTL_MS - 30_000;

function moreCautious(a: ClockTrust, b: ClockTrust): ClockTrust {
  // Ordered worst-first: a skewed reading from either source wins over anything else.
  if (a.kind === 'skewed') return a;
  if (b.kind === 'skewed') return b;
  if (a.kind === 'unverified') return a;
  if (b.kind === 'unverified') return b;
  // Both trusted — report the larger offset, so the number shown is the honest worst case.
  return Math.abs(a.offsetMs) >= Math.abs(b.offsetMs) ? a : b;
}

export function useClockTrust(apiBaseUrl: string | undefined): ClockTrust {
  // Starts unverified rather than trusted: until the server has actually answered, the honest
  // answer is that we do not know, and the safety engine should treat it that way.
  const [serverTrust, setServerTrust] = useState<ClockTrust>({ kind: 'unverified' });

  useEffect(() => {
    if (!apiBaseUrl) {
      return;
    }
    let cancelled = false;

    const run = async () => {
      const trust = await checkServerClock(apiBaseUrl);
      if (!cancelled) {
        setServerTrust(trust);
      }
    };

    void run();
    const timer = setInterval(() => void run(), REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [apiBaseUrl]);

  return moreCautious(serverTrust, getLocalClockTrust());
}
