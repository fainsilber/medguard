import { systemClock } from '@medguard/shared';
import { encodeBase64Url } from './base64url.js';
import type { PushResult } from './send.js';

/**
 * Firebase Cloud Messaging HTTP v1, WebCrypto only — no Node crypto, no `firebase-admin`, so it
 * runs on workerd.
 *
 * This is the same class of problem the sprint plan flagged as "the single most likely thing to
 * slip" for Web Push, and for the same reason: the vendor SDK assumes Node. There it was ECDSA
 * plus RFC 8291 encryption; here it is an RS256 service-account assertion exchanged for an OAuth
 * access token. Both end up being a few dozen lines of `crypto.subtle` once you stop trying to
 * make the library work.
 *
 * Deliberately mirrors `send.ts`'s shape — same `PushResult` union, same "expired" classification
 * — so `dispatch.ts` can treat a browser and a phone identically and everything above it stays
 * provider-blind.
 */

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** PKCS#8 PEM, exactly as it appears in the downloaded service-account JSON. */
  privateKeyPem: string;
}

/** The subset of a Google service-account JSON this needs. */
interface ServiceAccountJson {
  project_id?: unknown;
  client_email?: unknown;
  private_key?: unknown;
}

/**
 * Reads the service account from the `FCM_SERVICE_ACCOUNT` secret, or `null` when it isn't
 * configured.
 *
 * Absence is a supported state, not an error: a household running only the PWA needs no Firebase
 * project at all, and the Android client's local alarms are primary with the server push as a
 * backstop. `dispatch.ts` reports the gap per device rather than throwing, so "no FCM configured"
 * degrades to "web devices still get their pushes" instead of failing the whole fan-out.
 */
export function readFcmConfig(env: Env): FcmConfig | null {
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!raw) {
    return null;
  }

  let parsed: ServiceAccountJson;
  try {
    parsed = JSON.parse(raw) as ServiceAccountJson;
  } catch {
    return null;
  }

  const { project_id: projectId, client_email: clientEmail, private_key: privateKey } = parsed;
  if (
    typeof projectId !== 'string' ||
    typeof clientEmail !== 'string' ||
    typeof privateKey !== 'string'
  ) {
    return null;
  }

  return { projectId, clientEmail, privateKeyPem: privateKey };
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Google issues 1-hour tokens; refreshing at 55 minutes leaves margin for a slow round trip. */
const TOKEN_LIFETIME_MS = 55 * 60 * 1000;
const ASSERTION_LIFETIME_SECONDS = 60 * 60;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * Isolate-scoped, keyed by service account.
 *
 * Worth doing: without it every escalation to a three-device household would perform an RSA
 * signature and a round trip to Google before the first notification is even attempted, which is
 * latency spent in exactly the wrong place — a dose already fifteen minutes overdue. An isolate
 * that gets evicted simply signs again.
 */
const tokenCache = new Map<string, CachedToken>();

/** Test seam: the cache is module state, and one test's token must not leak into the next. */
export function resetFcmTokenCache(): void {
  tokenCache.clear();
}

/**
 * PEM → DER. `importKey('pkcs8', …)` wants the raw DER bytes, not the armoured text, and the
 * service-account JSON only ever contains the armoured text.
 */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function signAssertion(config: FcmConfig): Promise<string> {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(config.privateKeyPem) as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const issuedAt = Math.floor(systemClock.nowMs() / 1000);
  const encoder = new TextEncoder();
  const header = encodeBase64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = encodeBase64Url(
    encoder.encode(
      JSON.stringify({
        iss: config.clientEmail,
        scope: FCM_SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/** Thrown-free: callers turn a null token into a `PushResult` rather than a 500. */
async function getAccessToken(config: FcmConfig): Promise<string | null> {
  const cached = tokenCache.get(config.clientEmail);
  if (cached && cached.expiresAtMs > systemClock.nowMs()) {
    return cached.accessToken;
  }

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: await signAssertion(config),
      }).toString(),
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const body = (await response.json().catch(() => null)) as { access_token?: unknown } | null;
  if (!body || typeof body.access_token !== 'string') {
    return null;
  }

  tokenCache.set(config.clientEmail, {
    accessToken: body.access_token,
    expiresAtMs: systemClock.nowMs() + TOKEN_LIFETIME_MS,
  });
  return body.access_token;
}

/**
 * A dead registration token, told apart from a transient failure so `dispatch.ts` can prune it
 * once instead of retrying it forever.
 *
 * `UNREGISTERED` is the app being uninstalled or the token rotated. `INVALID_ARGUMENT` on a send
 * is, in practice, a malformed or foreign token — the rest of the message is machine-generated
 * from types, so there is nothing else in it for Google to object to.
 */
function classifyExpired(status: number, body: string): boolean {
  if (status === 404) return true;
  return (
    (status === 400 || status === 403) &&
    (body.includes('UNREGISTERED') || body.includes('INVALID_ARGUMENT'))
  );
}

export interface FcmSendOptions {
  /** How long FCM may hold the message for a sleeping device. A late dose alert is worse than none. */
  ttlSeconds?: number;
}

/**
 * Sends one **data-only** message.
 *
 * No `notification` block, deliberately: with one, Android composes and posts the notification
 * itself while the app is backgrounded, which means the wrong channel, no "Taken"/"Snooze"
 * actions, and — on Shabbat — action buttons this app must never show (delta D5). Data-only with
 * `HIGH` priority still wakes the device from Doze, and leaves the app in control of everything
 * a caregiver actually sees.
 */
export async function sendFcm(
  registrationToken: string,
  data: Record<string, string>,
  config: FcmConfig,
  options: FcmSendOptions = {},
): Promise<PushResult> {
  const accessToken = await getAccessToken(config);
  if (!accessToken) {
    return { ok: false, status: 0, error: 'fcm access token unavailable', expired: false };
  }

  let response: Response;
  try {
    response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: registrationToken,
            data,
            android: {
              priority: 'HIGH',
              ttl: `${options.ttlSeconds ?? 60}s`,
            },
          },
        }),
      },
    );
  } catch (cause) {
    return {
      ok: false,
      status: 0,
      error: cause instanceof Error ? cause.message : 'network error',
      expired: false,
    };
  }

  if (response.ok) {
    return { ok: true, status: response.status };
  }

  const body = (await response.text().catch(() => '')) || response.statusText;
  return {
    ok: false,
    status: response.status,
    error: body,
    expired: classifyExpired(response.status, body),
  };
}
