import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkServerClock } from './serverClockCheck.js';

const API = 'https://api.example.com';

function respondWith(nowMs: number, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => ({ nowMs, nowIso: new Date(nowMs).toISOString() }),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('checkServerClock', () => {
  it('trusts a clock that agrees with the server', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    vi.stubGlobal('fetch', respondWith(1_000_000));

    await expect(checkServerClock(API)).resolves.toMatchObject({ kind: 'trusted' });
  });

  it('flags a clock set far ahead of the server', async () => {
    // Device thinks it is an hour later than it is — enough to defeat a 4-hour cooldown check
    // repeatedly, which is exactly the failure this exists to catch.
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 3_600_000);
    vi.stubGlobal('fetch', respondWith(1_000_000));

    const trust = await checkServerClock(API);
    expect(trust.kind).toBe('skewed');
    expect(trust).toMatchObject({ offsetMs: expect.any(Number) });
  });

  it('flags a clock set far behind the server', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 - 3_600_000);
    vi.stubGlobal('fetch', respondWith(1_000_000));

    await expect(checkServerClock(API)).resolves.toMatchObject({ kind: 'skewed' });
  });

  it('tolerates ordinary drift within the allowed window', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000 + 30_000);
    vi.stubGlobal('fetch', respondWith(1_000_000));

    await expect(checkServerClock(API)).resolves.toMatchObject({ kind: 'trusted' });
  });

  it('does not mistake network latency for clock skew', async () => {
    // A three-minute round trip is absurd, but it proves the halving is applied: without it the
    // full latency would land outside the two-minute tolerance and block doses on a slow
    // connection for no reason.
    let call = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (call++ === 0 ? 1_000_000 : 1_000_000 + 180_000));
    vi.stubGlobal('fetch', respondWith(1_000_000 + 90_000));

    await expect(checkServerClock(API)).resolves.toMatchObject({ kind: 'trusted' });
  });

  it('returns unverified when the server cannot be reached — never trusted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    await expect(checkServerClock(API)).resolves.toEqual({ kind: 'unverified' });
  });

  it('returns unverified on a non-200 response', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    vi.stubGlobal('fetch', respondWith(1_000_000, { ok: false, status: 503 }));

    await expect(checkServerClock(API)).resolves.toEqual({ kind: 'unverified' });
  });

  it('returns unverified when the body is missing or malformed', async () => {
    for (const body of [{}, { nowMs: 'soon' }, { nowMs: Number.NaN }, null]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch,
      );
      await expect(checkServerClock(API)).resolves.toEqual({ kind: 'unverified' });
    }
  });

  it('returns unverified when the response is not JSON at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('unexpected token');
        },
      })) as unknown as typeof fetch,
    );

    await expect(checkServerClock(API)).resolves.toEqual({ kind: 'unverified' });
  });
});
