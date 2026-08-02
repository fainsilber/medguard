import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCurrentSubscription, subscribeToPush, unsubscribeFromPush } from './pushClient.js';

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const KEY_A = new Uint8Array([1, 2, 3, 4, 5]);
const KEY_B = new Uint8Array([9, 9, 9, 9, 9]);
const KEY_A_B64URL = encodeBase64Url(KEY_A);

function fakeSubscription(applicationServerKey: Uint8Array | null, endpoint = 'https://push.example.com/x') {
  return {
    endpoint,
    options: { applicationServerKey: applicationServerKey ? applicationServerKey.buffer : null },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function stubServiceWorker(pushManager: {
  getSubscription: () => Promise<ReturnType<typeof fakeSubscription> | null>;
  subscribe: ReturnType<typeof vi.fn>;
}) {
  vi.stubGlobal('navigator', {
    serviceWorker: {
      ready: Promise.resolve({ pushManager }),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('subscribeToPush', () => {
  it('subscribes fresh when there is no existing subscription', async () => {
    const newSubscription = fakeSubscription(KEY_A);
    const subscribe = vi.fn(async () => newSubscription);
    stubServiceWorker({ getSubscription: async () => null, subscribe });

    const result = await subscribeToPush(KEY_A_B64URL);

    expect(subscribe).toHaveBeenCalledOnce();
    expect(result).toEqual({ endpoint: newSubscription.endpoint, keys: { p256dh: 'p', auth: 'a' } });
  });

  it('reuses an existing subscription registered against the same key', async () => {
    const existing = fakeSubscription(KEY_A);
    const subscribe = vi.fn();
    stubServiceWorker({ getSubscription: async () => existing, subscribe });

    await subscribeToPush(KEY_A_B64URL);

    expect(subscribe).not.toHaveBeenCalled();
    expect(existing.unsubscribe).not.toHaveBeenCalled();
  });

  it('replaces a subscription registered against a different key', async () => {
    // The failure mode this guards against: silently keeping a subscription tied to a stale
    // VAPID key means the server signs pushes the push service then rejects — invisibly.
    const stale = fakeSubscription(KEY_B);
    const fresh = fakeSubscription(KEY_A);
    const subscribe = vi.fn(async () => fresh);
    stubServiceWorker({ getSubscription: async () => stale, subscribe });

    await subscribeToPush(KEY_A_B64URL);

    expect(stale.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it('treats a subscription with no recorded key as a mismatch', async () => {
    const existing = fakeSubscription(null);
    const fresh = fakeSubscription(KEY_A);
    const subscribe = vi.fn(async () => fresh);
    stubServiceWorker({ getSubscription: async () => existing, subscribe });

    await subscribeToPush(KEY_A_B64URL);

    expect(existing.unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });
});

describe('unsubscribeFromPush', () => {
  it('returns false when there is nothing to unsubscribe', async () => {
    stubServiceWorker({ getSubscription: async () => null, subscribe: vi.fn() });
    await expect(unsubscribeFromPush()).resolves.toBe(false);
  });

  it('unsubscribes and returns true when a subscription exists', async () => {
    const existing = fakeSubscription(KEY_A);
    stubServiceWorker({ getSubscription: async () => existing, subscribe: vi.fn() });

    await expect(unsubscribeFromPush()).resolves.toBe(true);
    expect(existing.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe('getCurrentSubscription', () => {
  it('returns null when unsubscribed', async () => {
    stubServiceWorker({ getSubscription: async () => null, subscribe: vi.fn() });
    await expect(getCurrentSubscription()).resolves.toBeNull();
  });

  it('returns the JSON form of an existing subscription', async () => {
    const existing = fakeSubscription(KEY_A);
    stubServiceWorker({ getSubscription: async () => existing, subscribe: vi.fn() });

    await expect(getCurrentSubscription()).resolves.toEqual({
      endpoint: existing.endpoint,
      keys: { p256dh: 'p', auth: 'a' },
    });
  });
});
