/**
 * The impure edge of the time/identity boundary.
 *
 * This is the only place in the shared package allowed to read the real clock or generate real
 * randomness — everything else takes a `Clock` or `IdGenerator`. Composition roots (the web app's
 * entry point, the Worker's request handler) construct these once and inject them downward.
 *
 * Exempt from the no-ambient-time ESLint rule by path (`**\/src/runtime/**`).
 */
import type { Clock, EpochMs, IdGenerator, IsoInstant } from '../clock.js';

export const systemClock: Clock = {
  nowMs(): EpochMs {
    return Date.now();
  },
  nowIso(): IsoInstant {
    return new Date().toISOString();
  },
};

/**
 * The single platform global this package depends on, typed locally rather than by pulling in
 * @types/node or the DOM lib — `packages/shared` must stay portable across the browser, workerd
 * and a future native client, so its platform surface is kept explicit and minimal.
 *
 * `crypto.randomUUID()` is available in browsers (secure context), Workers and Node 20+.
 */
const platformCrypto = (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto;

export const uuidIdGenerator: IdGenerator = {
  next(): string {
    return platformCrypto.randomUUID();
  },
};
