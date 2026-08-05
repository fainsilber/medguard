import { useEffect, useState } from 'react';

/**
 * Forces a re-render every `intervalMs`, so anything derived from "now" — the Today view's
 * overdue/due-now buckets, the PRN countdown — stays current without the caregiver having to
 * reload. Doesn't read time itself; each consumer still asks the injected clock what time it is
 * on every render, this just makes sure a render keeps happening.
 */
export function useTick(intervalMs: number): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
