/**
 * A stable identifier for this browser/device, used to attribute writes (`updatedByDeviceId`,
 * `loggedByDeviceId`) and to break Last-Write-Wins ties deterministically.
 *
 * Bootstrapping, not domain logic — the same reason `crypto.randomUUID()` is allowed directly
 * here despite the no-ambient-identity rule covering the db/features/sync layers.
 */
const STORAGE_KEY = 'medguard-device-id';

export function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, created);
  return created;
}
