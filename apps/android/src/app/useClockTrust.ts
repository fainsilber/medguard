import { getLocalClockTrust } from '@medguard/shared';
import type { ClockTrust } from '@medguard/shared';

/**
 * How much this device's clock can be trusted, for the PRN safety guards.
 *
 * **Local check only.** The web client also compares against the server (`serverClockCheck.ts`),
 * which is the only way to catch a clock that has *always* been wrong — no NTP sync, a wrong
 * timezone set at the OS level. This client has no API wiring yet, so that half is missing and
 * the honest consequence is recorded here rather than papered over: a phone whose clock was
 * already wrong when the app started will read as trusted.
 *
 * What it does catch is the case that matters most on a shared family device: the clock being
 * changed *during* a session, so a PRN cooldown appears to have already elapsed.
 */
export function useClockTrust(): ClockTrust {
  return getLocalClockTrust();
}
