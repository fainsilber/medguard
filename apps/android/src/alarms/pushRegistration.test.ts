import { beforeEach, describe, expect, it } from 'vitest';
import { registerForPush } from './pushRegistration.js';
import type { RegistrationPost } from './pushRegistration.js';

/**
 * Registering for the server's push backstop.
 *
 * Every branch here is a way this can fail on a real phone, and none of them may be fatal: local
 * alarms are the primary mechanism, and a household that has never set up a Firebase project is a
 * supported configuration. What matters is that each outcome is *reported* — "not registered" has
 * to reach `alarmHealth` so a caregiver learns that an escalation would not arrive, rather than
 * discovering it the night a dose is missed.
 */

let requests: { url: string; token: string; body: unknown }[] = [];
let postResult: Awaited<ReturnType<RegistrationPost>> = { ok: true, value: { ok: true } };

const post: RegistrationPost = async (url, options) => {
  requests.push({ url, token: options.token, body: options.body });
  return postResult;
};

const deps = {
  apiBaseUrl: 'https://api.example.invalid',
  deviceToken: 'device-token',
  post,
};

beforeEach(() => {
  requests = [];
  postResult = { ok: true, value: { ok: true } };
});

describe('registerForPush', () => {
  it('sends the fcm token under this device’s own credential', async () => {
    const outcome = await registerForPush({
      ...deps,
      getPushToken: async () => 'fcm-registration-token',
    });

    expect(outcome).toEqual({ kind: 'registered' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.example.invalid/api/v1/devices/push');
    expect(requests[0]?.body).toEqual({ provider: 'fcm', token: 'fcm-registration-token' });
    expect(requests[0]?.token).toBe('device-token');
  });

  it('reports a build with no Firebase project instead of failing', async () => {
    const outcome = await registerForPush({ ...deps, getPushToken: async () => null });

    expect(outcome).toEqual({ kind: 'no_token' });
    expect(requests).toEqual([]);
  });

  it('treats a native module that throws as simply having no token', async () => {
    const outcome = await registerForPush({
      ...deps,
      getPushToken: async () => {
        throw new Error('Default FirebaseApp is not initialized');
      },
    });

    expect(outcome).toEqual({ kind: 'no_token' });
    expect(requests).toEqual([]);
  });

  it('reports a rejected registration rather than pretending it worked', async () => {
    postResult = { ok: false, error: 'This device is no longer signed in to a household.' };

    const outcome = await registerForPush({ ...deps, getPushToken: async () => 'token' });

    expect(outcome).toEqual({
      kind: 'failed',
      error: 'This device is no longer signed in to a household.',
    });
  });
});
