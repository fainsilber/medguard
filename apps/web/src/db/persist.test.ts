import { describe, expect, it, vi } from 'vitest';
import { requestPersistentStorage } from './persist.js';

function storageManager(overrides: Partial<StorageManager>): StorageManager {
  return overrides as StorageManager;
}

describe('requestPersistentStorage', () => {
  it('reports unsupported when the API is missing', async () => {
    await expect(requestPersistentStorage(storageManager({}))).resolves.toEqual({
      supported: false,
      persisted: false,
    });
  });

  it('reports unsupported when nothing is passed and there is no navigator.storage', async () => {
    await expect(requestPersistentStorage(undefined)).resolves.toMatchObject({ supported: false });
  });

  it('does not re-request when persistence was already granted', async () => {
    // Re-asking can re-prompt on some browsers, for no benefit.
    const persist = vi.fn();
    const result = await requestPersistentStorage(
      storageManager({ persisted: async () => true, persist }),
    );

    expect(result).toEqual({ supported: true, persisted: true });
    expect(persist).not.toHaveBeenCalled();
  });

  it('requests persistence when not yet granted', async () => {
    const persist = vi.fn(async () => true);
    const result = await requestPersistentStorage(
      storageManager({ persisted: async () => false, persist }),
    );

    expect(result).toEqual({ supported: true, persisted: true });
    expect(persist).toHaveBeenCalledOnce();
  });

  it('reports honestly when the browser refuses', async () => {
    const result = await requestPersistentStorage(
      storageManager({ persisted: async () => false, persist: async () => false }),
    );

    expect(result).toEqual({ supported: true, persisted: false });
  });
});
