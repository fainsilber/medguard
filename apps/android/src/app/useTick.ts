import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * Forces a re-render every `intervalMs`, so anything derived from "now" — the Today view's
 * overdue/due-now buckets, the PRN countdown — stays current without the caregiver having to
 * reload. Doesn't read time itself; each consumer still asks the injected clock what time it is
 * on every render, this just makes sure a render keeps happening.
 *
 * Also ticks once immediately on every foreground resume, not just on the interval. RN's JS
 * timers don't fire while the app is backgrounded (real device sleep, Doze) — `setInterval` simply
 * stops making progress, the same failure mode `apps/android/src/clock/localClockGuard.ts`
 * documents for `performance.now()`. `Date.now()` itself keeps advancing correctly through that
 * gap (it's the timer callback that stalls, not the clock), so without this a caregiver who
 * unlocks the phone after it sat for a few hours sees a PRN cooldown stuck at whatever it read
 * when the screen last rendered — reporting far more time locked than has actually elapsed —
 * until the next scheduled tick happens to land. Unlike `apps/web/src/app/useTick.ts`, which stays
 * plain `setInterval`: a browser tab doesn't survive real OS-level suspend the same way.
 */
export function useTick(intervalMs: number): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    const tick = () => setTick((t) => t + 1);
    const id = setInterval(tick, intervalMs);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        tick();
      }
    });
    return () => {
      clearInterval(id);
      subscription.remove();
    };
  }, [intervalMs]);
}
