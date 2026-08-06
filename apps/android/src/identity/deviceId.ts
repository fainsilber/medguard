import * as SecureStore from 'expo-secure-store';
import { deviceIdGenerator } from '../runtime/deviceRuntime.js';

/**
 * A stable identifier for this device, used to attribute writes (`updatedByDeviceId`,
 * `loggedByDeviceId`) and to break Last-Write-Wins ties deterministically — the Android
 * equivalent of `apps/web/src/identity/deviceId.ts`, backed by `expo-secure-store` instead of
 * `localStorage`.
 *
 * Generation goes through `deviceIdGenerator` (`runtime/deviceRuntime.ts`) rather than calling
 * `expo-crypto` directly here — that file is the one sanctioned ambient-identity edge for this
 * app (see eslint.config.js), so every other file, including this bootstrapping one, still goes
 * through it rather than opening a second exemption.
 */
const STORAGE_KEY = 'medguard-device-id';

export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(STORAGE_KEY);
  if (existing) {
    return existing;
  }
  const created = deviceIdGenerator.next();
  await SecureStore.setItemAsync(STORAGE_KEY, created);
  return created;
}
