import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Typed locally for the same reason the module under test does it: `packages/shared` declares
 * neither the DOM lib nor @types/node, so `performance` has no ambient declaration here.
 */
const platformPerformance = (globalThis as unknown as { performance: { now(): number } })
  .performance;

/**
 * The module captures its reference point once, at import time, from ambient `Date.now()` and
 * `performance.now()` — exactly the pattern that makes it useful in production and awkward to
 * test. `vi.resetModules()` plus a dynamic import gives each test a fresh module instance with
 * its own reference, captured under mocks we control.
 */
async function loadWithReference(wallMs: number, monoMs: number) {
  vi.spyOn(Date, 'now').mockReturnValue(wallMs);
  vi.spyOn(platformPerformance, 'now').mockReturnValue(monoMs);
  const module = await import('./localClockGuard.js');
  return module.getLocalClockTrust;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getLocalClockTrust', () => {
  it('trusts the clock when wall time and monotonic time advance together', async () => {
    const getLocalClockTrust = await loadWithReference(1_000_000, 5_000);

    vi.mocked(Date.now).mockReturnValue(1_000_000 + 10_000);
    vi.mocked(platformPerformance.now).mockReturnValue(5_000 + 10_000);

    expect(getLocalClockTrust()).toEqual({ kind: 'trusted', offsetMs: 0 });
  });

  it('flags a wall clock that jumped forward relative to real elapsed time', async () => {
    // The scenario this exists for: someone winds the clock forward mid-session to make a
    // cooldown appear to have already elapsed.
    const getLocalClockTrust = await loadWithReference(1_000_000, 5_000);

    vi.mocked(Date.now).mockReturnValue(1_000_000 + 10 * 60_000); // wall: +10 minutes
    vi.mocked(platformPerformance.now).mockReturnValue(5_000 + 1_000); // real: +1 second

    const trust = getLocalClockTrust();
    expect(trust.kind).toBe('skewed');
    expect(trust.kind === 'skewed' && trust.offsetMs).toBeGreaterThan(0);
  });

  it('flags a wall clock that jumped backward', async () => {
    const getLocalClockTrust = await loadWithReference(1_000_000, 5_000);

    vi.mocked(Date.now).mockReturnValue(1_000_000 - 10 * 60_000); // wall: -10 minutes
    vi.mocked(platformPerformance.now).mockReturnValue(5_000 + 1_000);

    const trust = getLocalClockTrust();
    expect(trust.kind).toBe('skewed');
    expect(trust.kind === 'skewed' && trust.offsetMs).toBeLessThan(0);
  });

  it('tolerates drift within the shared skew tolerance', async () => {
    const { CLOCK_SKEW_TOLERANCE_MS } = await import('../clock.js');
    const getLocalClockTrust = await loadWithReference(1_000_000, 5_000);

    vi.mocked(Date.now).mockReturnValue(1_000_000 + (CLOCK_SKEW_TOLERANCE_MS - 1));
    vi.mocked(platformPerformance.now).mockReturnValue(5_000);

    expect(getLocalClockTrust().kind).toBe('trusted');
  });

  it('flags drift exactly one millisecond past the tolerance', async () => {
    const { CLOCK_SKEW_TOLERANCE_MS } = await import('../clock.js');
    const getLocalClockTrust = await loadWithReference(1_000_000, 5_000);

    vi.mocked(Date.now).mockReturnValue(1_000_000 + (CLOCK_SKEW_TOLERANCE_MS + 1));
    vi.mocked(platformPerformance.now).mockReturnValue(5_000);

    expect(getLocalClockTrust().kind).toBe('skewed');
  });

  it('does not re-anchor between calls — repeated checks agree', async () => {
    const getLocalClockTrust = await loadWithReference(1_000_000, 5_000);

    vi.mocked(Date.now).mockReturnValue(1_000_000 + 20 * 60_000);
    vi.mocked(platformPerformance.now).mockReturnValue(5_000 + 1_000);

    const first = getLocalClockTrust();
    const second = getLocalClockTrust();
    expect(first).toEqual(second);
  });
});
