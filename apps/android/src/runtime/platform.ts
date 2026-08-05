import { Capacitor } from '@capacitor/core';

/**
 * Where this bundle is actually running.
 *
 * The same web assets serve `npm run dev` in a desktop browser and the Capacitor WebView on a
 * phone, and several capabilities exist only in the second case. The UI reports the honest
 * answer rather than claiming native behaviour it does not have — safety invariant 6 requires
 * degradation to be visible, and a badge that says a push channel is live when it is not is
 * worse than no badge at all.
 */
export type AndroidPlatform = 'android' | 'web';

export function currentPlatform(): AndroidPlatform {
  return Capacitor.getPlatform() === 'android' ? 'android' : 'web';
}

export function isNativeAndroid(): boolean {
  return currentPlatform() === 'android';
}
