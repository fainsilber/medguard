import { encodeBase64Url } from '../push/base64url.js';

/**
 * Generation, hashing and comparison of the two credentials in the system: the 6-digit join code
 * a caregiver reads aloud, and the device token that stands in for it afterwards.
 *
 * Everything here uses WebCrypto, which workerd provides natively — no Node built-ins, so this
 * runs unchanged in the real runtime and in tests.
 */

/** Digits, not letters: this gets read over the phone or across a hospital room. */
const JOIN_CODE_LENGTH = 6;

/**
 * 32 bytes of entropy. Unlike the join code this is never typed by a human, so it can be as long
 * as we like — and it is the credential that persists, so it is the one that must not be guessable.
 */
const DEVICE_TOKEN_BYTES = 32;

/**
 * A uniformly distributed 6-digit code.
 *
 * Rejection sampling rather than `% 1_000_000`: the modulo of a 32-bit value is biased toward
 * lower codes, which measurably shrinks the search space for anyone brute forcing. The loop
 * discards the small biased tail instead.
 */
export function generateJoinCode(): string {
  const limit = 10 ** JOIN_CODE_LENGTH;
  const ceiling = Math.floor(0xffffffff / limit) * limit;

  const buffer = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0]!;
  } while (value >= ceiling);

  return String(value % limit).padStart(JOIN_CODE_LENGTH, '0');
}

/** An opaque bearer token for a device, base64url so it survives a header unescaped. */
export function generateDeviceToken(): string {
  const bytes = new Uint8Array(DEVICE_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

/**
 * SHA-256, hex encoded — what actually gets stored.
 *
 * Deliberately a plain hash rather than a slow password KDF: these are high-entropy machine
 * generated secrets with a short life, not human-chosen passwords, so there is no dictionary to
 * defend against and the cost of a KDF would buy nothing. What it does buy is that a leaked
 * database backup contains no usable credential.
 */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Compares two hex digests in time independent of how many leading characters match.
 *
 * A plain `===` returns as soon as it finds a difference, and that timing difference is
 * measurable across enough requests — it lets an attacker learn a valid token one character at a
 * time instead of guessing all of it at once.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Reads the bearer token from an Authorization header, or undefined if there isn't a usable one. */
export function bearerTokenFrom(header: string | null | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}
