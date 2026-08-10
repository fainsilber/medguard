import type { ApiResult } from '../api/householdApi.js';

/**
 * Telling the server how to reach this device (Sprint A4).
 *
 * The local alarm is primary and needs none of this. What registration buys is the backstop: the
 * dose alert that still arrives when this device's own alarms have been suppressed by an OEM
 * battery manager, and — the part no device can do for itself — the *escalation* when a dose goes
 * unconfirmed, which only the household's Durable Object can decide to send.
 *
 * Every failure here is survivable and none of it throws: `registerForPush` reports what
 * happened, and `AlarmProvider` turns "not registered" into the `no_server_backstop` risk rather
 * than into an error a caregiver can do nothing about.
 *
 * Both the POST and the token read are injected rather than imported. `householdApi.ts` pulls in
 * `expo-device`, and through it React Native, which the Vitest project cannot load — injecting
 * keeps every branch of this decision testable off-device, the same discipline `AlarmEngine`
 * applies to the native surface.
 */

export type PushRegistrationOutcome =
  | { kind: 'registered' }
  /** No Firebase project in this build, or Firebase has not issued a token yet. */
  | { kind: 'no_token' }
  | { kind: 'failed'; error: string };

export type RegistrationPost = (
  url: string,
  options: { token: string; body: unknown },
) => Promise<ApiResult<{ ok: true }>>;

export interface PushRegistrationDeps {
  apiBaseUrl: string;
  deviceToken: string;
  /** `MedGuardAlarms.getPushToken`. */
  getPushToken: () => Promise<string | null>;
  /** `(url, options) => request('POST', url, options)`. */
  post: RegistrationPost;
}

export async function registerForPush({
  apiBaseUrl,
  deviceToken,
  getPushToken,
  post,
}: PushRegistrationDeps): Promise<PushRegistrationOutcome> {
  let token: string | null;
  try {
    token = await getPushToken();
  } catch {
    // The native module is missing or Firebase failed to initialise — the normal state for a
    // build with no `google-services.json`. Indistinguishable, from here, from having no token.
    return { kind: 'no_token' };
  }

  if (!token) {
    return { kind: 'no_token' };
  }

  // Idempotent on the server, which is what makes calling it on every start the right design:
  // Firebase rotates tokens without telling the app, and the only cheap way to be sure the
  // server's copy is current is to send the current one again.
  const result = await post(`${apiBaseUrl}/api/v1/devices/push`, {
    token: deviceToken,
    body: { provider: 'fcm', token },
  });

  return result.ok ? { kind: 'registered' } : { kind: 'failed', error: result.error };
}
