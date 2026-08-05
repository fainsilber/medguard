/**
 * The impure edge of the time/identity boundary for this app — the Android equivalent of
 * `packages/shared/src/runtime/`. Everything else in `apps/android/src` takes a `Clock` and an
 * `IdGenerator` rather than reaching for globals (see eslint.config.js, extended to
 * `apps/android/src/**` with this directory as the only exempt path).
 *
 * `systemClock` from `@medguard/shared` works unchanged here — `Date.now()` and
 * `new Date().toISOString()` are available under Hermes. Identity is not: React Native's
 * `crypto.randomUUID()` is not guaranteed present (RN 0.86 as of this writing does not polyfill
 * the WebCrypto `crypto` global the way a browser or workerd does), so this app supplies its own
 * `IdGenerator` backed by `expo-crypto`, which calls into the platform's real CSPRNG.
 */
import { systemClock } from '@medguard/shared';
import type { Clock, IdGenerator } from '@medguard/shared';
import * as Crypto from 'expo-crypto';

export const deviceClock: Clock = systemClock;

export const deviceIdGenerator: IdGenerator = {
  next(): string {
    return Crypto.randomUUID();
  },
};
