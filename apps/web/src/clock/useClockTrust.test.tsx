import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useClockTrust } from './useClockTrust.js';

/**
 * `useClockTrust` combines the server check (`checkServerClock`, already fully tested in
 * `serverClockCheck.test.ts`) with the local monotonic guard (`getLocalClockTrust`, tested in
 * `localClockGuard.test.ts`) via `moreCautious` — the one piece with no direct test of its own
 * until now. What matters here isn't re-proving either check, it's proving the combination itself:
 * neither check alone is trusted, only the more pessimistic of the two.
 *
 * The local side isn't mocked as a separate module — `localClockGuard.ts`'s reference point is
 * real ambient `Date.now()`/`performance.now()` captured once at import, so driving it away from
 * "trusted" here means mocking those globals to make the wall-clock and monotonic deltas diverge
 * wildly relative to that real (unknown, but fixed) reference — the same technique its own test
 * file uses, just without needing to know the reference's exact value.
 */

function respondWith(nowMs: number) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ nowMs, nowIso: new Date(nowMs).toISOString() }),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useClockTrust', () => {
  it('is unverified when there is no API base URL to check against', () => {
    const { result } = renderHook(() => useClockTrust(undefined));

    expect(result.current).toEqual({ kind: 'unverified' });
  });

  it('is unverified before the server check has resolved', () => {
    vi.stubGlobal('fetch', respondWith(Date.now()));

    const { result } = renderHook(() => useClockTrust('https://api.example.com'));

    // Synchronous first render — the effect's fetch hasn't resolved yet.
    expect(result.current.kind).toBe('unverified');
  });

  it('becomes trusted once a healthy server check resolves, with the local guard also healthy', async () => {
    vi.stubGlobal('fetch', respondWith(Date.now()));

    const { result } = renderHook(() => useClockTrust('https://api.example.com'));

    await waitFor(() => expect(result.current.kind).toBe('trusted'));
  });

  it('reports skewed when the server check finds the clock skewed, regardless of the local guard', async () => {
    // An hour ahead of the server — well past the tolerance.
    vi.stubGlobal('fetch', respondWith(Date.now() - 3_600_000));

    const { result } = renderHook(() => useClockTrust('https://api.example.com'));

    await waitFor(() => expect(result.current.kind).toBe('skewed'));
  });

  it('reports skewed from the local guard even when the server check comes back healthy', async () => {
    // The property this whole hook exists for: a server check performed a moment ago cannot see a
    // clock tampered with *since* — only the local monotonic guard catches that, so a healthy
    // server reading must never silently override it.
    //
    // Date.now is pinned to a single fixed value for the whole test, matched by the server's
    // response — checkServerClock reads it for both the request timestamp and the response
    // timestamp, so a constant value makes its own math see zero round-trip and zero offset (a
    // healthy check). localClockGuard.ts's reference point, though, was captured at real module
    // import time, long before this mock was installed — comparing that real reference against
    // this same pinned, unrelated value produces a huge, unmistakable drift on the local side.
    vi.stubGlobal('fetch', respondWith(1_000_000));
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    vi.spyOn(performance, 'now').mockReturnValue(0);

    const { result } = renderHook(() => useClockTrust('https://api.example.com'));

    await waitFor(() => expect(result.current.kind).toBe('skewed'));
  });
});
