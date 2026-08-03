import type { HouseholdSession } from './session.js';

/**
 * The household and join-code endpoints.
 *
 * Errors are returned as values rather than thrown: every caller here is a form that needs to show
 * the caregiver what went wrong, and a rejected promise would just have to be converted back.
 */

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Server error codes mapped to something a caregiver can act on, rather than shown raw. */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_code: "That code didn't work. It may have expired or already been used — ask for a new one.",
  too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
  invalid_request: 'Please check the details and try again.',
  unauthorized: 'This device is no longer signed in to a household.',
};

function messageFor(code: unknown): string {
  return typeof code === 'string' && ERROR_MESSAGES[code]
    ? ERROR_MESSAGES[code]
    : 'Could not reach the server. Check your connection and try again.';
}

async function postJson<T>(url: string, body: unknown, token?: string): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      return { ok: false, error: messageFor((payload as { error?: unknown })?.error) };
    }
    return { ok: true, value: payload as T };
  } catch {
    return { ok: false, error: messageFor(undefined) };
  }
}

export function createHousehold(
  apiBaseUrl: string,
  input: { householdName: string; displayName: string },
): Promise<ApiResult<HouseholdSession>> {
  return postJson<HouseholdSession>(`${apiBaseUrl}/api/v1/households`, {
    ...input,
    platform: navigator.userAgent.slice(0, 50),
  });
}

export function redeemJoinCode(
  apiBaseUrl: string,
  input: { code: string; displayName: string },
): Promise<ApiResult<HouseholdSession>> {
  return postJson<HouseholdSession>(`${apiBaseUrl}/api/v1/join-codes/redeem`, {
    ...input,
    platform: navigator.userAgent.slice(0, 50),
  });
}

export function issueJoinCode(
  apiBaseUrl: string,
  token: string,
): Promise<ApiResult<{ code: string; expiresAt: string; expiresInSeconds: number }>> {
  return postJson(`${apiBaseUrl}/api/v1/join-codes`, {}, token);
}
