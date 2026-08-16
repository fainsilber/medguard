import * as SecureStore from 'expo-secure-store';
import { getOrCreateDeviceId } from './deviceId.js';

/**
 * RN port of `apps/web/src/identity/deviceId.test.ts` — `expo-secure-store` instead of
 * `localStorage`, generation via `runtime/deviceRuntime.ts`'s `deviceIdGenerator` (backed by
 * `expo-crypto`, mocked to Node's own `crypto.randomUUID` for tests — see
 * `testUtils/mockExpoCrypto.ts`) instead of web's direct `crypto.randomUUID()`.
 */

const STORAGE_KEY = 'medguard-device-id';

beforeEach(async () => {
  await SecureStore.deleteItemAsync(STORAGE_KEY);
});

afterEach(async () => {
  await SecureStore.deleteItemAsync(STORAGE_KEY);
});

describe('getOrCreateDeviceId', () => {
  it('creates an id on first call', async () => {
    const id = await getOrCreateDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the same id on every subsequent call', async () => {
    const first = await getOrCreateDeviceId();
    const second = await getOrCreateDeviceId();
    expect(second).toBe(first);
  });

  it('persists across what stands in for an app restart — a fresh read from storage', async () => {
    const id = await getOrCreateDeviceId();
    expect(await SecureStore.getItemAsync(STORAGE_KEY)).toBe(id);
  });
});
