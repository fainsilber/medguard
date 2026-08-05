/**
 * A stable identifier for this Android install, used to attribute writes
 * (`updatedByDeviceId`, `loggedByDeviceId`) and to break Last-Write-Wins ties deterministically.
 *
 * Bootstrapping, not domain logic — the same reason `crypto.randomUUID()` is allowed directly
 * here despite the no-ambient-identity rule covering the db/features layers.
 *
 * NOTE: on a real device this belongs in the Android Keystore rather than WebView localStorage
 * (docs/android-client-plan.md, "Storage and the sync port"). localStorage is what a Capacitor
 * WebView offers without a native plugin, and it is cleared if the user clears app storage —
 * which re-registers the device rather than losing data, since every record is server-synced by
 * id. Revisit when the push-credential registration lands.
 */
const STORAGE_KEY = 'medguard-android-device-id';

export function getOrCreateDeviceId(): string {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) {
    return existing;
  }
  const created = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, created);
  return created;
}
