/**
 * Jest mock for `expo-secure-store` (mapped in `jest.config.js`) — jest-expo's preset doesn't
 * mock this module (Android Keystore has no headless equivalent), and its real JS wrapper throws
 * before ever reaching a native call. Backed by an in-memory `Map`, scoped to one test file's
 * run — close enough to "a fresh install" for rendering tests, which don't assert persistence
 * across app restarts.
 */
const store = new Map<string, string>();

export async function getItemAsync(key: string): Promise<string | null> {
  return store.get(key) ?? null;
}

export async function setItemAsync(key: string, value: string): Promise<void> {
  if (typeof value !== 'string') {
    throw new TypeError('Values must be strings; consider JSON-encoding your values if they are serializable.');
  }
  store.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  store.delete(key);
}
