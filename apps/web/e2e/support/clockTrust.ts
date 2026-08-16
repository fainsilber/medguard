import type { Page } from '@playwright/test';

/**
 * Used by prn-safety.spec.ts and dose-correction.spec.ts, both of which exercise `PrnCard` — the
 * one screen that consults `getLocalClockTrust()` (apps/web/src/clock/localClockGuard.ts).
 *
 * That guard flags the device's clock as untrusted when elapsed `Date.now()` and elapsed
 * `performance.now()` since page load disagree by more than `CLOCK_SKEW_TOLERANCE_MS` — real
 * tamper detection on a real device, but a false positive risk in a virtualized CI runner, where
 * the two clock sources aren't guaranteed to advance in lockstep under scheduling pressure (a
 * throttled or briefly descheduled browser process can let one drift against the other with
 * nobody having touched either clock). None of these specs are testing clock-tamper detection —
 * that's `apps/web/src/clock/useClockTrust.test.tsx` and `localClockGuard`'s own unit tests — so
 * pinning `performance.now()` to derive from the same `Date.now()` calls the guard itself reads
 * removes a source of flakiness that has nothing to do with what's under test here, rather than
 * trying to out-wait it.
 */
export async function pinPerformanceClockToWallClock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const startMs = Date.now();
    Object.defineProperty(window.performance, 'now', {
      value: () => Date.now() - startMs,
      configurable: true,
    });
  });
}
