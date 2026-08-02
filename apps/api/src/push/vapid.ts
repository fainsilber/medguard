import { systemClock } from '@medguard/shared';
import { decodeBase64Url, encodeBase64Url } from './base64url.js';

/**
 * VAPID (RFC 8292) request signing.
 *
 * Identifies this application server to the push service with a short-lived ES256 JWT, so the
 * service will accept messages for our subscriptions.
 */

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** Push services reject tokens valid for more than 24h; 12h leaves comfortable margin. */
const TOKEN_LIFETIME_SECONDS = 12 * 60 * 60;

/**
 * Rebuilds a signing key from the base64url `d` scalar plus the public key.
 *
 * WebCrypto will only import an EC private key as a JWK, which requires the public
 * coordinates alongside the private scalar — those are the two halves of the uncompressed
 * public point (0x04 ‖ x ‖ y).
 */
async function importPrivateKey(config: VapidConfig): Promise<CryptoKey> {
  const publicBytes = decodeBase64Url(config.publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  }

  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: config.privateKey,
      x: encodeBase64Url(publicBytes.subarray(1, 33)),
      y: encodeBase64Url(publicBytes.subarray(33, 65)),
      ext: true,
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/**
 * Builds the `Authorization` header for a push to `endpoint`.
 *
 * The audience is the endpoint's origin, not the full URL — a token scoped to the push service,
 * not to one subscription.
 */
export async function createVapidAuthorization(
  endpoint: string,
  config: VapidConfig,
): Promise<string> {
  const audience = new URL(endpoint).origin;
  const expiry = Math.floor(systemClock.nowMs() / 1000) + TOKEN_LIFETIME_SECONDS;

  const encoder = new TextEncoder();
  const header = encodeBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = encodeBase64Url(
    encoder.encode(JSON.stringify({ aud: audience, exp: expiry, sub: config.subject })),
  );
  const signingInput = `${header}.${payload}`;

  // WebCrypto emits the raw r‖s pair ECDSA JWS requires, rather than a DER wrapper.
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await importPrivateKey(config),
    encoder.encode(signingInput),
  );

  const jwt = `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
  return `vapid t=${jwt}, k=${config.publicKey}`;
}
