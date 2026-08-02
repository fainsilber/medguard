/**
 * Asks the browser not to evict the local database under storage pressure.
 *
 * Matters more here than in a typical app: the database holds intake logs that have not synced
 * yet, and eviction would silently destroy a record of doses actually given. Whether the request
 * is granted is the browser's decision (usually tied to whether the app is installed or
 * frequently used), which is why the Sprint 0 capability probe measures it per device rather
 * than assuming.
 */
export interface PersistenceResult {
  supported: boolean;
  persisted: boolean;
}

export async function requestPersistentStorage(
  storage: StorageManager | undefined = globalThis.navigator?.storage,
): Promise<PersistenceResult> {
  if (!storage?.persist || !storage.persisted) {
    return { supported: false, persisted: false };
  }

  // Already granted — asking again would re-prompt on some browsers for no benefit.
  if (await storage.persisted()) {
    return { supported: true, persisted: true };
  }

  return { supported: true, persisted: await storage.persist() };
}
