import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFcmConfig, resetFcmTokenCache, sendFcm } from '../src/push/fcm.js';
import type { FcmConfig } from '../src/push/fcm.js';
import {
  TEST_PRIVATE_KEY_PEM,
  TEST_PROJECT_ID,
  TEST_PUBLIC_KEY_PEM,
} from './fcmTestKey.js';

/**
 * The FCM HTTP v1 sender, exercised end-to-end against a mocked Google.
 *
 * Everything that can be wrong here is invisible until a dose alert fails to arrive on a locked
 * phone, so the assertions are about the exact bytes on the wire: that the assertion really is an
 * RS256 JWT verifiable with the service account's public key, that the message is data-only (a
 * `notification` block would let Android post its own notification on the wrong channel, with
 * action buttons Shabbat must never show), and that a dead token is classified as expired so the
 * dispatcher prunes it instead of retrying forever.
 */

const config: FcmConfig = {
  projectId: TEST_PROJECT_ID,
  clientEmail: 'medguard@medguard-test.iam.gserviceaccount.invalid',
  privateKeyPem: TEST_PRIVATE_KEY_PEM,
};

const SEND_PATH = '/v1/projects/medguard-test/messages:send';

function decodeSegment(segment: string): Record<string, unknown> {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))) as Record<
    string,
    unknown
  >;
}

function derFromPem(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
}

/** Proves the assertion is a real RS256 signature over its own header and claims. */
async function verifyAssertion(jwt: string): Promise<boolean> {
  const [header, claims, signature] = jwt.split('.') as [string, string, string];
  const key = await crypto.subtle.importKey(
    'spki',
    derFromPem(TEST_PUBLIC_KEY_PEM) as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const padded = signature.replace(/-/g, '+').replace(/_/g, '/');
  const signatureBytes = Uint8Array.from(
    atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')),
    (char) => char.charCodeAt(0),
  );
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signatureBytes as BufferSource,
    new TextEncoder().encode(`${header}.${claims}`),
  );
}

/**
 * `fetch` is stubbed at the global rather than intercepted with undici's MockAgent: this version
 * of `@cloudflare/vitest-pool-workers` does not export `fetchMock`, and the boundary that
 * actually matters here is the request this module builds, which a global stub captures exactly.
 */
let capturedAssertions: string[] = [];
let capturedMessages: Record<string, unknown>[] = [];
let tokenReply: { status: number; body: unknown } = {
  status: 200,
  body: { access_token: 'test-access-token', expires_in: 3600 },
};
let sendReplies: { status: number; body: unknown }[] = [];

beforeEach(() => {
  resetFcmTokenCache();
  capturedAssertions = [];
  capturedMessages = [];
  tokenReply = { status: 200, body: { access_token: 'test-access-token', expires_in: 3600 } };
  sendReplies = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? '');

    if (url === 'https://oauth2.googleapis.com/token') {
      capturedAssertions.push(new URLSearchParams(body).get('assertion') ?? '');
      return new Response(JSON.stringify(tokenReply.body), { status: tokenReply.status });
    }

    if (url === `https://fcm.googleapis.com${SEND_PATH}`) {
      capturedMessages.push(JSON.parse(body) as Record<string, unknown>);
      const reply = sendReplies.shift();
      if (!reply) throw new Error(`unexpected send: ${body}`);
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }

    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function expectSend(status: number, body: unknown, times = 1): void {
  for (let i = 0; i < times; i += 1) sendReplies.push({ status, body });
}

describe('readFcmConfig', () => {
  it('returns null when the secret is absent, so a household with no Firebase project still works', () => {
    expect(readFcmConfig({ FCM_SERVICE_ACCOUNT: '' } as Env)).toBeNull();
  });

  it('returns null on malformed JSON rather than throwing mid-fan-out', () => {
    expect(readFcmConfig({ FCM_SERVICE_ACCOUNT: '{not json' } as Env)).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    const raw = JSON.stringify({ project_id: 'p', client_email: 'e@example.invalid' });
    expect(readFcmConfig({ FCM_SERVICE_ACCOUNT: raw } as Env)).toBeNull();
  });

  it('reads a well-formed service account', () => {
    const raw = JSON.stringify({
      project_id: 'medguard-test',
      client_email: 'e@example.invalid',
      private_key: TEST_PRIVATE_KEY_PEM,
    });
    expect(readFcmConfig({ FCM_SERVICE_ACCOUNT: raw } as Env)).toEqual({
      projectId: 'medguard-test',
      clientEmail: 'e@example.invalid',
      privateKeyPem: TEST_PRIVATE_KEY_PEM,
    });
  });
});

describe('sendFcm', () => {
  it('signs a verifiable RS256 assertion scoped to firebase.messaging', async () => {
    expectSend(200, { name: 'projects/medguard-test/messages/1' });

    const result = await sendFcm('device-token', { payload: '{}' }, config);

    expect(result).toEqual({ ok: true, status: 200 });

    const jwt = capturedAssertions[0] as string;
    const [header, claims] = jwt.split('.') as [string, string];
    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decodeSegment(claims)).toMatchObject({
      iss: config.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
    });
    await expect(verifyAssertion(jwt)).resolves.toBe(true);
  });

  it('sends a data-only HIGH-priority message — a notification block would let Android compose its own', async () => {
    expectSend(200, { name: 'projects/medguard-test/messages/1' });

    await sendFcm('device-token', { payload: '{"kind":"dose"}', title: 'x' }, config, {
      ttlSeconds: 120,
    });

    const message = capturedMessages[0]?.message as Record<string, unknown>;
    expect(message.token).toBe('device-token');
    expect(message.data).toEqual({ payload: '{"kind":"dose"}', title: 'x' });
    expect(message.notification).toBeUndefined();
    expect(message.android).toEqual({ priority: 'HIGH', ttl: '120s' });
  });

  it('reuses the cached access token instead of signing again for every device in a household', async () => {
    expectSend(200, {}, 2);

    await sendFcm('device-a', { payload: '{}' }, config);
    await sendFcm('device-b', { payload: '{}' }, config);

    expect(capturedAssertions).toHaveLength(1);
  });

  it('classifies UNREGISTERED as expired so the dispatcher prunes the token once', async () => {
    expectSend(404, { error: { status: 'NOT_FOUND', message: 'Requested entity was not found' } });

    const result = await sendFcm('dead-token', { payload: '{}' }, config);

    expect(result).toMatchObject({ ok: false, status: 404, expired: true });
  });

  it('classifies a 400 INVALID_ARGUMENT as expired — the rest of the message is machine-generated', async () => {
    expectSend(400, { error: { status: 'INVALID_ARGUMENT', message: 'bad token' } });

    const result = await sendFcm('garbage-token', { payload: '{}' }, config);

    expect(result).toMatchObject({ ok: false, expired: true });
  });

  it('treats a server error as transient, never as a dead token', async () => {
    expectSend(503, { error: { status: 'UNAVAILABLE' } });

    const result = await sendFcm('device-token', { payload: '{}' }, config);

    expect(result).toMatchObject({ ok: false, status: 503, expired: false });
  });

  it('fails soft when the token exchange itself is rejected', async () => {
    tokenReply = { status: 401, body: { error: 'invalid_grant' } };

    const result = await sendFcm('device-token', { payload: '{}' }, config);

    expect(result).toEqual({
      ok: false,
      status: 0,
      error: 'fcm access token unavailable',
      expired: false,
    });
  });
});
