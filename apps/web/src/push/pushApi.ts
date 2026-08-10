import type { ApiResult } from '../api/householdApi.js';
import { request } from '../api/householdApi.js';

/**
 * Push registration, behind device auth.
 *
 * Replaces the Sprint 0 probe's unauthenticated `/api/v1/probe/*` routes (delta AD8). A device
 * registers only its own subscription, and which device that is comes from the bearer token
 * rather than from anything in the body.
 */

export function fetchVapidPublicKey(
  apiBaseUrl: string,
  token: string,
): Promise<ApiResult<{ publicKey: string }>> {
  return request('GET', `${apiBaseUrl}/api/v1/devices/push/vapid-public-key`, { token });
}

export function registerPushSubscription(
  apiBaseUrl: string,
  token: string,
  subscription: PushSubscriptionJSON,
): Promise<ApiResult<{ ok: true }>> {
  return request('POST', `${apiBaseUrl}/api/v1/devices/push`, {
    token,
    body: { provider: 'webpush', subscription },
  });
}

export function unregisterPush(apiBaseUrl: string, token: string): Promise<ApiResult<{ ok: true }>> {
  return request('DELETE', `${apiBaseUrl}/api/v1/devices/push`, { token });
}
