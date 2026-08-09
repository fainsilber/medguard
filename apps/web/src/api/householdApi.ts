import type { HouseholdSession } from './session.js';

/**
 * The household, join-code, and device-lifecycle endpoints.
 *
 * Errors are returned as values rather than thrown: every caller here is a form or a confirm
 * dialog that needs to show the caregiver what went wrong, and a rejected promise would just have
 * to be converted back.
 */

/** `code` is the raw server error code (`'unauthorized'`, say) alongside `error`'s translated,
 * user-facing message — `packages/store/src/syncEngine.ts`'s `SyncApiResult` mirrors this exact
 * shape so `syncApi.ts` needs no adapter, and threads `code` through so a caller like
 * `SyncProvider` can react to *which* failure this was without parsing `error`'s prose. */
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

export interface DeviceInfo {
  id: string;
  platform: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  userId: string;
  displayName: string;
  isThisDevice: boolean;
}

/** Server error codes mapped to something a caregiver can act on, rather than shown raw. */
const ERROR_MESSAGES: Record<string, string> = {
  invalid_code: "That code didn't work. It may have expired or already been used — ask for a new one.",
  too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
  invalid_request: 'Please check the details and try again.',
  unauthorized: 'This device is no longer signed in to a household.',
  not_found: 'That device could not be found — it may have already been removed.',
};

function messageFor(code: unknown): string {
  return typeof code === 'string' && ERROR_MESSAGES[code]
    ? ERROR_MESSAGES[code]
    : 'Could not reach the server. Check your connection and try again.';
}

export async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  options: { body?: unknown; token?: string } = {},
): Promise<ApiResult<T>> {
  const { body, token } = options;

  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const rawCode = (payload as { error?: unknown })?.error;
      return {
        ok: false,
        error: messageFor(rawCode),
        ...(typeof rawCode === 'string' ? { code: rawCode } : {}),
      };
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
  return request(
    'POST',
    `${apiBaseUrl}/api/v1/households`,
    { body: { ...input, platform: navigator.userAgent.slice(0, 50) } },
  );
}

export function redeemJoinCode(
  apiBaseUrl: string,
  input: { code: string; displayName: string },
): Promise<ApiResult<HouseholdSession>> {
  return request(
    'POST',
    `${apiBaseUrl}/api/v1/join-codes/redeem`,
    { body: { ...input, platform: navigator.userAgent.slice(0, 50) } },
  );
}

export function issueJoinCode(
  apiBaseUrl: string,
  token: string,
): Promise<ApiResult<{ code: string; expiresAt: string; expiresInSeconds: number }>> {
  return request('POST', `${apiBaseUrl}/api/v1/join-codes`, { body: {}, token });
}

/**
 * Revokes the calling device's own token server-side — the half of "sign out" that a merely
 * local sign-out can't do. Without this, a token that was somehow retained elsewhere (an old
 * browser tab, a stray backup) would stay valid indefinitely.
 */
export function leaveHousehold(apiBaseUrl: string, token: string): Promise<ApiResult<{ ok: true }>> {
  return request('POST', `${apiBaseUrl}/api/v1/leave`, { body: {}, token });
}

/** Every device in the caller's household — what a "revoke a lost phone" screen lists from. */
export function listDevices(
  apiBaseUrl: string,
  token: string,
): Promise<ApiResult<{ devices: DeviceInfo[] }>> {
  return request('GET', `${apiBaseUrl}/api/v1/devices`, { token });
}

/** Revokes one device — this device or another's — cutting off its token immediately. */
export function revokeDevice(
  apiBaseUrl: string,
  token: string,
  deviceId: string,
): Promise<ApiResult<{ ok: true }>> {
  return request('DELETE', `${apiBaseUrl}/api/v1/devices/${encodeURIComponent(deviceId)}`, { token });
}

/**
 * Deletes the entire household — every caregiver, device, and medical record in it, permanently.
 * Any member may call this; there is no owner/member distinction anywhere in this system.
 */
export function deleteHousehold(apiBaseUrl: string, token: string): Promise<ApiResult<{ ok: true }>> {
  return request('DELETE', `${apiBaseUrl}/api/v1/households`, { token });
}
