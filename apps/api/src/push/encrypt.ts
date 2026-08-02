/**
 * Web Push payload encryption, RFC 8291 (`aes128gcm`), using WebCrypto only.
 *
 * Written by hand rather than taken from a library because every WebCrypto web-push package on
 * npm still emits the legacy `aesgcm` scheme from draft-04. Chrome tolerates that; **Apple's
 * APNs Web Push does not** — it accepts `aes128gcm` only. Using a legacy library would mean
 * push silently never working on iOS, which is half the caregivers' devices.
 *
 * Correctness is proven against the worked example in RFC 8291 §5 (see encrypt.test.ts), so the
 * implementation is verified without needing a device or a live push service.
 */

const UNCOMPRESSED_POINT_BYTES = 65;

/** Record size. 4096 is the conventional default and comfortably exceeds our payloads. */
const RECORD_SIZE = 4096;

export interface ClientKeys {
  /** `p256dh` from the browser's PushSubscription: the client's uncompressed P-256 public key. */
  p256dh: Uint8Array;
  /** `auth` from the browser's PushSubscription: 16 bytes of shared authentication secret. */
  auth: Uint8Array;
}

/** Deterministic inputs, supplied only by tests so the RFC's worked example can be reproduced. */
export interface EncryptOverrides {
  salt?: Uint8Array;
  serverKeyPair?: CryptoKeyPair;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * HKDF (RFC 5869) via WebCrypto, which performs extract-and-expand in one call — exactly the
 * shape each of the three derivations below needs.
 */
async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

function labelWithNul(label: string): Uint8Array {
  return concat(new TextEncoder().encode(label), new Uint8Array([0]));
}

export interface EncryptedPush {
  /** The full `aes128gcm` body: salt ‖ rs ‖ idlen ‖ server public key ‖ ciphertext. */
  body: Uint8Array;
}

export async function encryptPayload(
  plaintext: Uint8Array,
  clientKeys: ClientKeys,
  overrides: EncryptOverrides = {},
): Promise<EncryptedPush> {
  if (clientKeys.p256dh.length !== UNCOMPRESSED_POINT_BYTES) {
    throw new Error(`p256dh must be ${UNCOMPRESSED_POINT_BYTES} bytes, got ${clientKeys.p256dh.length}`);
  }

  const salt = overrides.salt ?? crypto.getRandomValues(new Uint8Array(16));

  // Ephemeral server keypair, fresh per message.
  // generateKey is typed as returning CryptoKeyPair | CryptoKey; for ECDH it is always a pair.
  const serverKeyPair =
    overrides.serverKeyPair ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair);

  const serverPublicBytes = new Uint8Array(
    (await crypto.subtle.exportKey('raw', serverKeyPair.publicKey)) as ArrayBuffer,
  );

  const clientPublicKey = await crypto.subtle.importKey(
    'raw',
    clientKeys.p256dh as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  // Cloudflare's generated runtime types spell this parameter `$public` (their IDL generator
  // escapes the reserved word), but workerd requires `public` at runtime. Cast across the gap.
  type DeriveBitsAlgorithm = Parameters<typeof crypto.subtle.deriveBits>[0];
  const ecdhParams = { name: 'ECDH', public: clientPublicKey } as unknown as DeriveBitsAlgorithm;

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhParams, serverKeyPair.privateKey, 256),
  );

  // RFC 8291 §3.3 — bind the derived key to both parties' public keys, so a captured payload
  // cannot be replayed against a different subscription.
  const keyInfo = concat(labelWithNul('WebPush: info'), clientKeys.p256dh, serverPublicBytes);
  const ikm = await hkdf(sharedSecret, clientKeys.auth, keyInfo, 32);

  const contentEncryptionKey = await hkdf(ikm, salt, labelWithNul('Content-Encoding: aes128gcm'), 16);
  const nonce = await hkdf(ikm, salt, labelWithNul('Content-Encoding: nonce'), 12);

  // RFC 8188 §2 — 0x02 marks this as the final record. (0x01 would mean more records follow.)
  const padded = concat(plaintext, new Uint8Array([2]));

  const aesKey = await crypto.subtle.importKey('raw', contentEncryptionKey as BufferSource, 'AES-GCM', false, [
    'encrypt',
  ]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource, tagLength: 128 }, aesKey, padded as BufferSource),
  );

  // RFC 8188 §2.1 header block: salt(16) ‖ record size(4, big-endian) ‖ idlen(1) ‖ keyid.
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, RECORD_SIZE, false);

  return {
    body: concat(
      salt,
      recordSize,
      new Uint8Array([serverPublicBytes.length]),
      serverPublicBytes,
      ciphertext,
    ),
  };
}
