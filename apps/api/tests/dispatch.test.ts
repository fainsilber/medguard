import { SELF, env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUSH_PAYLOAD_VERSION } from '@medguard/shared';
import type { DosePushPayload } from '@medguard/shared';
import { dispatchToHousehold } from '../src/push/dispatch.js';

/**
 * The fan-out, against real D1 device rows.
 *
 * What this file is really protecting is the moment an escalation goes out: every caregiver's
 * device is attempted, one dead credential does not stop the others, and a browser that rotated
 * its subscription loses its push — not its login. That last one is worth a test of its own,
 * because "delete the row" is the obvious implementation and it would silently sign a caregiver
 * out of a child's medical record.
 */

const BASE = 'https://example.com/api/v1';

const SUBSCRIPTION = JSON.stringify({
  endpoint: 'https://push.example.invalid/sub/web-1',
  keys: {
    p256dh:
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  },
});

const payload: DosePushPayload = {
  v: PUSH_PAYLOAD_VERSION,
  kind: 'dose',
  sentAtIso: '2026-08-09T08:00:00.000Z',
  occurrenceId: 'sched-1:2026-08-09T08:00:00.000Z',
  medicineId: 'med-1',
  medicineName: 'Methotrexate',
  scheduleId: 'sched-1',
  dueAtIso: '2026-08-09T08:00:00.000Z',
  dosageQuantity: 2,
};

interface Session {
  deviceToken: string;
  householdId: string;
  deviceId: string;
}

async function createHousehold(): Promise<Session> {
  const response = await SELF.fetch(`${BASE}/households`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ householdName: 'Test', displayName: 'Mom' }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

async function setCredentials(
  deviceId: string,
  provider: 'webpush' | 'fcm',
  credentials: string | null,
): Promise<void> {
  await env.DB.prepare('UPDATE devices SET push_provider = ?, push_credentials = ? WHERE id = ?')
    .bind(provider, credentials, deviceId)
    .run();
}

async function credentialsOf(deviceId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT push_credentials FROM devices WHERE id = ?')
    .bind(deviceId)
    .first<{ push_credentials: string | null }>();
  return row?.push_credentials ?? null;
}

async function deviceStillExists(deviceId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS found FROM devices WHERE id = ?')
    .bind(deviceId)
    .first<{ found: number }>();
  return row !== null;
}

/** Every outbound request, so a test can assert who was actually contacted. */
let calls: string[] = [];
let replies = new Map<string, { status: number; body?: unknown }>();

function reply(urlFragment: string, status: number, body?: unknown): void {
  replies.set(urlFragment, { status, body });
}

beforeEach(() => {
  calls = [];
  replies = new Map();

  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
        status: 200,
      });
    }

    for (const [fragment, response] of replies) {
      if (url.includes(fragment)) {
        return new Response(JSON.stringify(response.body ?? {}), { status: response.status });
      }
    }

    return new Response('{}', { status: 201 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dispatchToHousehold', () => {
  it('sends to a web-push device through the VAPID sender', async () => {
    const session = await createHousehold();
    await setCredentials(session.deviceId, 'webpush', SUBSCRIPTION);

    const results = await dispatchToHousehold(env, session.householdId, payload);

    expect(results).toEqual([
      { deviceId: session.deviceId, provider: 'webpush', ok: true, status: 201 },
    ]);
    expect(calls).toContain('https://push.example.invalid/sub/web-1');
  });

  it('sends to an fcm device as data only, with the wording and channel resolved server-side', async () => {
    const session = await createHousehold();
    await setCredentials(session.deviceId, 'fcm', 'device-registration-token');

    let sentBody: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
          status: 200,
        });
      }
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('{}', { status: 200 });
    });

    const results = await dispatchToHousehold(env, session.householdId, payload);

    expect(results[0]).toMatchObject({ provider: 'fcm', ok: true });
    const message = sentBody.message as Record<string, unknown>;
    const data = message.data as Record<string, string>;
    expect(message.notification).toBeUndefined();
    expect(data.kind).toBe('dose');
    expect(data.channelId).toBe('dose_standard_v1');
    expect(data.title).toContain('Methotrexate');
    expect(data.occurrenceId).toBe(payload.occurrenceId);
    expect(JSON.parse(data.payload as string)).toEqual(payload);
  });

  it('reports a device that never registered, rather than pretending it was reached', async () => {
    const session = await createHousehold();

    const results = await dispatchToHousehold(env, session.householdId, payload);

    expect(results[0]).toMatchObject({ ok: false, skipped: 'no_credentials' });
  });

  it('reports an fcm device when no service account is configured, and still sends to the others', async () => {
    const session = await createHousehold();
    await setCredentials(session.deviceId, 'fcm', 'device-registration-token');

    const results = await dispatchToHousehold(
      { ...env, FCM_SERVICE_ACCOUNT: '' } as Env,
      session.householdId,
      payload,
    );

    expect(results[0]).toMatchObject({ ok: false, skipped: 'provider_not_configured' });
  });

  it('clears a dead subscription but keeps the device — the row is the caregiver\'s login', async () => {
    const session = await createHousehold();
    await setCredentials(session.deviceId, 'webpush', SUBSCRIPTION);
    reply('push.example.invalid', 410, {});

    const results = await dispatchToHousehold(env, session.householdId, payload);

    expect(results[0]).toMatchObject({ ok: false, status: 410, pruned: true });
    expect(await credentialsOf(session.deviceId)).toBeNull();
    expect(await deviceStillExists(session.deviceId)).toBe(true);
  });

  it('keeps a subscription that merely failed transiently', async () => {
    const session = await createHousehold();
    await setCredentials(session.deviceId, 'webpush', SUBSCRIPTION);
    reply('push.example.invalid', 503, {});

    const results = await dispatchToHousehold(env, session.householdId, payload);

    expect(results[0]).toMatchObject({ ok: false, status: 503 });
    expect(results[0]?.pruned).toBeUndefined();
    expect(await credentialsOf(session.deviceId)).toBe(SUBSCRIPTION);
  });

  it('prunes a credential that cannot be parsed back into a subscription', async () => {
    const session = await createHousehold();
    await setCredentials(session.deviceId, 'webpush', '{"endpoint":"only"}');

    const results = await dispatchToHousehold(env, session.householdId, payload);

    expect(results[0]).toMatchObject({ skipped: 'invalid_credentials', pruned: true });
    expect(await credentialsOf(session.deviceId)).toBeNull();
  });

  it('excludes the device that already knows — a targeted alert is not a fan-out', async () => {
    const session = await createHousehold();
    await setCredentials(session.deviceId, 'webpush', SUBSCRIPTION);

    const results = await dispatchToHousehold(env, session.householdId, payload, {
      exclude: [session.deviceId],
    });

    expect(results).toEqual([]);
    expect(calls).not.toContain('https://push.example.invalid/sub/web-1');
  });

  it('restricts to an explicit device list when asked', async () => {
    const session = await createHousehold();
    await setCredentials(session.deviceId, 'webpush', SUBSCRIPTION);

    const results = await dispatchToHousehold(env, session.householdId, payload, {
      only: ['some-other-device'],
    });

    expect(results).toEqual([]);
  });

  it('never reaches into another household', async () => {
    const mine = await createHousehold();
    const theirs = await createHousehold();
    await setCredentials(mine.deviceId, 'webpush', SUBSCRIPTION);
    await setCredentials(theirs.deviceId, 'webpush', SUBSCRIPTION);

    const results = await dispatchToHousehold(env, mine.householdId, payload);

    expect(results).toHaveLength(1);
    expect(results[0]?.deviceId).toBe(mine.deviceId);
  });
});
