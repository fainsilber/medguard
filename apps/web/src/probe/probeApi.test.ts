import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchServerLog, fetchVapidPublicKey, scheduleBurst } from './probeApi.js';

function mockFetch(response: { ok: boolean; status?: number; json?: unknown; text?: string }) {
  return vi.fn(
    async () =>
      ({
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 500),
        json: async () => response.json,
        text: async () => response.text ?? '',
      }) as Response,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchVapidPublicKey', () => {
  it('returns the public key on success', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: true, json: { publicKey: 'BAbc123' } }));

    await expect(fetchVapidPublicKey('https://api.example.com')).resolves.toBe('BAbc123');
  });

  it('throws with the status and body when the server rejects the request', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 503, text: 'vapid not configured' }));

    await expect(fetchVapidPublicKey('https://api.example.com')).rejects.toThrow(/503/);
  });
});

describe('scheduleBurst', () => {
  it('posts the burst parameters and returns the schedule result', async () => {
    const fetchMock = mockFetch({
      ok: true,
      json: { scheduled: 3, firstDueAtIso: '2026-08-02T09:00:20.000Z', requestedAtIso: '2026-08-02T09:00:00.000Z' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await scheduleBurst('https://api.example.com', {
      probeId: 'device-1',
      subscription: { endpoint: 'https://push.example.com/x', keys: { p256dh: 'a', auth: 'b' } },
      delaySeconds: 20,
      burstCount: 3,
      spacingMs: 15_000,
    });

    expect(result.scheduled).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/probe/push',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('surfaces a validation failure from the server', async () => {
    vi.stubGlobal('fetch', mockFetch({ ok: false, status: 400, text: '{"error":"invalid_subscription"}' }));

    await expect(
      scheduleBurst('https://api.example.com', {
        probeId: 'device-1',
        subscription: { endpoint: 'x', keys: { p256dh: 'a', auth: 'b' } },
        delaySeconds: 0,
        burstCount: 1,
        spacingMs: 0,
      }),
    ).rejects.toThrow(/invalid_subscription/);
  });
});

describe('fetchServerLog', () => {
  it('URL-encodes the probe id', async () => {
    const fetchMock = mockFetch({ ok: true, json: { pending: 0, sent: [] } });
    vi.stubGlobal('fetch', fetchMock);

    await fetchServerLog('https://api.example.com', 'a device/with slashes');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/api/v1/probe/push-log/a%20device%2Fwith%20slashes',
    );
  });
});
