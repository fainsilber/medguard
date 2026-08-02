import { SELF, env, listDurableObjectIds, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHABBAT_BURST_COUNT } from '@medguard/shared';

/**
 * Proves the whole Web Push path works without a phone: VAPID signing and aes128gcm encryption
 * under WebCrypto (the spike that would otherwise land mid-Sprint 5), and Durable Object Alarms
 * driving a scheduled burst.
 *
 * Outbound fetch is stubbed, so nothing ever reaches a real push service — and stubbing rather
 * than intercepting lets us assert what was actually put on the wire.
 */

const PUSH_ENDPOINT = 'https://push.example.com/send/abc123';

interface CapturedPush {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Replaces global fetch and records every push request. */
function capturePushes(status = 201, statusText = 'Created') {
  const captured: CapturedPush[] = [];

  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    captured.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: new Uint8Array(await request.arrayBuffer()),
    });
    return new Response(status >= 400 ? statusText.toLowerCase() : '', { status, statusText });
  });

  return captured;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...view))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** A structurally valid subscription with a real P-256 client key, so encryption actually runs. */
async function makeSubscription() {
  const keyPair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  return {
    endpoint: PUSH_ENDPOINT,
    expirationTime: null,
    keys: {
      p256dh: base64url((await crypto.subtle.exportKey('raw', keyPair.publicKey)) as ArrayBuffer),
      auth: base64url(crypto.getRandomValues(new Uint8Array(16))),
    },
  };
}

async function schedule(body: Record<string, unknown>) {
  return SELF.fetch('https://example.com/api/v1/probe/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/v1/probe/vapid-public-key', () => {
  it('returns the configured public key', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/probe/vapid-public-key');

    expect(response.status).toBe(200);
    const { publicKey } = await response.json<{ publicKey: string }>();
    // Uncompressed P-256 point: 65 bytes, base64url, always starting 0x04 -> "B".
    expect(publicKey.startsWith('B')).toBe(true);
    expect(publicKey).toHaveLength(87);
  });
});

describe('POST /api/v1/probe/push validation', () => {
  it('rejects a missing probe id', async () => {
    const response = await schedule({ subscription: await makeSubscription() });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'probe_id_required' });
  });

  it('rejects a malformed subscription', async () => {
    const response = await schedule({ probeId: 'p1', subscription: { endpoint: 'x' } });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_subscription' });
  });

  it('rejects a non-JSON body', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/probe/push', {
      method: 'POST',
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });
});

describe('scheduled push burst', () => {
  it('queues the default Shabbat burst without sending immediately', async () => {
    const response = await schedule({
      probeId: 'burst',
      subscription: await makeSubscription(),
      delaySeconds: 15,
    });

    expect(response.status).toBe(200);
    // Asserts against the shared constant rather than a literal, so this test can't drift
    // silently out of sync the way it would have if SHABBAT_BURST_COUNT changed but this
    // number didn't — which is exactly what almost happened tuning the burst from field data.
    await expect(response.json()).resolves.toMatchObject({ scheduled: SHABBAT_BURST_COUNT });

    // Nothing sent yet — the delay is what lets the phone be locked first.
    const log = await SELF.fetch('https://example.com/api/v1/probe/push-log/burst');
    await expect(log.json()).resolves.toMatchObject({ pending: SHABBAT_BURST_COUNT, sent: [] });
  });

  it('sends a correctly signed, encrypted push when the alarm fires', async () => {
    const captured = capturePushes();

    await schedule({
      probeId: 'wire',
      subscription: await makeSubscription(),
      delaySeconds: 60,
      burstCount: 1,
    });

    const stub = env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName('probe:wire'));
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    expect(captured).toHaveLength(1);
    const push = captured[0]!;

    expect(push.url).toBe(PUSH_ENDPOINT);
    expect(push.method).toBe('POST');
    // VAPID: a signed JWT identifying us to the push service.
    expect(push.headers['authorization']).toMatch(/^(vapid|WebPush)/i);
    expect(push.headers['authorization']).toContain('eyJ');
    // RFC 8291 payload encryption. Without this the push service rejects the message.
    expect(push.headers['content-encoding']).toBe('aes128gcm');
    expect(push.headers['ttl']).toBeDefined();
    // Encrypted, therefore not readable as our plaintext payload.
    expect(push.body.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(push.body)).not.toContain('MedGuard test alert');
  });

  it('sends one push per alarm and re-arms for the rest', async () => {
    // Each burst member is its own alarm: a DO holds one alarm at a time, so the burst is a
    // chain. This is the mechanism Sprint 5's dose scheduling and escalation both rely on.
    const captured = capturePushes();

    await schedule({
      probeId: 'chain',
      subscription: await makeSubscription(),
      delaySeconds: 60,
      burstCount: 2,
      spacingMs: 15_000,
    });

    const stub = env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName('probe:chain'));

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterFirst = await stub.getProbeLog();
    expect(afterFirst.sent).toHaveLength(1);
    expect(afterFirst.sent[0]).toMatchObject({ ok: true, status: 201, burstIndex: 1, burstTotal: 2 });
    expect(afterFirst.pending).toBe(1);

    // A second alarm was armed for the remaining member.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const afterSecond = await stub.getProbeLog();
    expect(afterSecond.sent).toHaveLength(2);
    expect(afterSecond.sent[1]).toMatchObject({ burstIndex: 2 });
    expect(afterSecond.pending).toBe(0);
    expect(captured).toHaveLength(2);

    // Queue drained, so no further alarm should be armed.
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it('records a failed send instead of losing it', async () => {
    // Telling "the server never sent it" apart from "the phone never showed it" is the whole
    // diagnostic value of the probe log.
    capturePushes(410, 'Gone');

    await schedule({
      probeId: 'failure',
      subscription: await makeSubscription(),
      delaySeconds: 60,
      burstCount: 1,
    });

    const stub = env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName('probe:failure'));
    await runDurableObjectAlarm(stub);

    const { sent } = await stub.getProbeLog();
    expect(sent[0]).toMatchObject({ ok: false, status: 410 });
  });

  it('keeps separate probe devices in separate Durable Objects', async () => {
    await schedule({ probeId: 'device-a', subscription: await makeSubscription(), burstCount: 1 });

    const ids = await listDurableObjectIds(env.HOUSEHOLD);
    const deviceA = env.HOUSEHOLD.idFromName('probe:device-a');
    expect(ids.some((id) => id.equals(deviceA))).toBe(true);

    // A device that never scheduled anything has an empty log of its own.
    const other = env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName('probe:device-b'));
    await expect(other.getProbeLog()).resolves.toEqual({ pending: 0, sent: [] });
  });
});
