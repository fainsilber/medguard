/**
 * base64url (RFC 4648 §5) — the encoding `PushManager.subscribe`'s `applicationServerKey`
 * expects, and the encoding the server's VAPID public key arrives in.
 *
 * Deliberately not shared with apps/api/src/push/base64url.ts: this is throwaway probe
 * plumbing (see ../README note in ProbePage.tsx), not part of the tested domain contract that
 * belongs in packages/shared.
 */
export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
