/**
 * Generates a VAPID keypair for Web Push.
 *
 * VAPID uses ECDSA over P-256. The public key is the uncompressed EC point (65 bytes) and the
 * private key is the 32-byte scalar `d`, both base64url-encoded — the format push services and
 * `PushManager.subscribe()` expect.
 *
 * Run: node scripts/generate-vapid-keys.mjs
 *
 * The private key is a secret. Put it in apps/api/.dev.vars for local development (gitignored)
 * and in Cloudflare with `wrangler secret put VAPID_PRIVATE_KEY` for deployed environments.
 * Never commit it.
 */
function base64url(bytes) {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);

const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

const publicKey = base64url(new Uint8Array(publicKeyRaw));
const privateKey = privateKeyJwk.d; // already base64url per JWK spec

console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log(`VAPID_SUBJECT=mailto:you@example.com`);
console.log();
console.log('Local dev  : paste the three lines above into apps/api/.dev.vars (gitignored)');
console.log('Deployed   : wrangler secret put VAPID_PRIVATE_KEY   (public key + subject go in wrangler.jsonc vars)');
