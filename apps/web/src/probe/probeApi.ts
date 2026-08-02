import type { ProbeNotificationOptions, ProbePushLog } from '@medguard/shared';

export interface ScheduleBurstParams {
  probeId: string;
  subscription: PushSubscriptionJSON;
  delaySeconds: number;
  burstCount: number;
  spacingMs: number;
  options?: ProbeNotificationOptions | undefined;
}

export interface ScheduleBurstResult {
  scheduled: number;
  firstDueAtIso: string;
  requestedAtIso: string;
}

async function parseJsonOrThrow<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${label} failed: ${response.status} ${body}`.trim());
  }
  return response.json() as Promise<T>;
}

export async function fetchVapidPublicKey(apiBaseUrl: string): Promise<string> {
  const response = await fetch(`${apiBaseUrl}/api/v1/probe/vapid-public-key`);
  const { publicKey } = await parseJsonOrThrow<{ publicKey: string }>(response, 'vapid-public-key');
  return publicKey;
}

export async function scheduleBurst(
  apiBaseUrl: string,
  params: ScheduleBurstParams,
): Promise<ScheduleBurstResult> {
  const response = await fetch(`${apiBaseUrl}/api/v1/probe/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  return parseJsonOrThrow<ScheduleBurstResult>(response, 'schedule push');
}

export async function fetchServerLog(apiBaseUrl: string, probeId: string): Promise<ProbePushLog> {
  const response = await fetch(`${apiBaseUrl}/api/v1/probe/push-log/${encodeURIComponent(probeId)}`);
  return parseJsonOrThrow<ProbePushLog>(response, 'push-log');
}
