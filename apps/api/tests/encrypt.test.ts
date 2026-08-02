import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64Url } from '../src/push/base64url.js';
import { encryptPayload } from '../src/push/encrypt.js';

/**
 * Verifies the aes128gcm implementation against the worked example in RFC 8291 §5.
 *
 * The RFC fixes every normally-random input (the server's ephemeral keypair and the salt) and
 * publishes the exact expected ciphertext. Reproducing it byte-for-byte proves the ECDH, the
 * three HKDF derivations, the record padding and the AES-GCM step are all correct — without a
 * phone, a push service, or a network.
 */

const RFC8291 = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  expectedBody:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** Rebuilds the RFC's fixed server keypair, which is random in production. */
async function importServerKeyPair(): Promise<CryptoKeyPair> {
  const publicBytes = decodeBase64Url(RFC8291.asPublic);
  const algorithm = { name: 'ECDH', namedCurve: 'P-256' } as const;

  const privateKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: RFC8291.asPrivate,
      x: encodeBase64Url(publicBytes.subarray(1, 33)),
      y: encodeBase64Url(publicBytes.subarray(33, 65)),
      ext: true,
      key_ops: ['deriveBits'],
    },
    algorithm,
    true,
    ['deriveBits'],
  );

  const publicKey = await crypto.subtle.importKey(
    'raw',
    publicBytes as BufferSource,
    algorithm,
    true,
    [],
  );

  return { privateKey, publicKey };
}

describe('RFC 8291 aes128gcm', () => {
  it('reproduces the specification worked example byte for byte', async () => {
    const { body } = await encryptPayload(
      new TextEncoder().encode(RFC8291.plaintext),
      {
        p256dh: decodeBase64Url(RFC8291.uaPublic),
        auth: decodeBase64Url(RFC8291.authSecret),
      },
      {
        salt: decodeBase64Url(RFC8291.salt),
        serverKeyPair: await importServerKeyPair(),
      },
    );

    expect(encodeBase64Url(body)).toBe(RFC8291.expectedBody);
  });

  it('lays out the RFC 8188 header block correctly', async () => {
    const { body } = await encryptPayload(
      new TextEncoder().encode('x'),
      { p256dh: decodeBase64Url(RFC8291.uaPublic), auth: decodeBase64Url(RFC8291.authSecret) },
    );

    expect(body.subarray(0, 16)).toHaveLength(16); // salt
    expect(new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false)).toBe(4096); // rs
    expect(body[20]).toBe(65); // key id length
    expect(body[21]).toBe(0x04); // uncompressed EC point marker
  });

  it('produces a different body each time, since salt and keypair are fresh', async () => {
    const keys = {
      p256dh: decodeBase64Url(RFC8291.uaPublic),
      auth: decodeBase64Url(RFC8291.authSecret),
    };
    const plaintext = new TextEncoder().encode('same message');

    const first = await encryptPayload(plaintext, keys);
    const second = await encryptPayload(plaintext, keys);

    expect(encodeBase64Url(first.body)).not.toBe(encodeBase64Url(second.body));
  });

  it('rejects a client key that is not an uncompressed P-256 point', async () => {
    await expect(
      encryptPayload(new TextEncoder().encode('x'), {
        p256dh: new Uint8Array(10),
        auth: decodeBase64Url(RFC8291.authSecret),
      }),
    ).rejects.toThrow(/65 bytes/);
  });
});

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(200));
    expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
  });

  it('emits no padding or non-url-safe characters', () => {
    const encoded = encodeBase64Url(new Uint8Array([251, 255, 190, 255]));
    expect(encoded).not.toMatch(/[+/=]/);
  });
});
