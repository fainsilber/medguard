import * as SecureStore from 'expo-secure-store';

/**
 * Which caregiver is using this device — the Android equivalent of
 * `apps/web/src/identity/caregiverName.ts`, backed by `expo-secure-store` (Android Keystore)
 * instead of `localStorage`. Not authentication, same as web: it exists purely to satisfy safety
 * invariant 5 (every log records who and when) before a caregiver connects to a household.
 *
 * `expo-secure-store` has no synchronous read, unlike `localStorage` — every caller here is
 * already async as a result (see `CaregiverGate.tsx`'s loading state), a deliberate, documented
 * deviation from web's synchronous first-paint read.
 */
const STORAGE_KEY = 'medguard-caregiver-name';

export function getCaregiverName(): Promise<string | null> {
  return SecureStore.getItemAsync(STORAGE_KEY);
}

export async function setCaregiverName(name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new RangeError('Caregiver name cannot be blank');
  }
  await SecureStore.setItemAsync(STORAGE_KEY, trimmed);
}

export async function clearCaregiverName(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEY);
}
