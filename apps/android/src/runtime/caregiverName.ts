/**
 * Which caregiver is using this device.
 *
 * Deliberately not authentication — there is no password and nothing stops someone typing any
 * name. It exists to satisfy safety invariant 5 (every log records who and when — no anonymous
 * entries) on a single device, and mirrors `apps/web/src/identity/caregiverName.ts` so both
 * clients attribute writes the same way.
 */
const STORAGE_KEY = 'medguard-android-caregiver-name';

export function getCaregiverName(): string | null {
  return localStorage.getItem(STORAGE_KEY);
}

export function setCaregiverName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new RangeError('Caregiver name cannot be blank');
  }
  localStorage.setItem(STORAGE_KEY, trimmed);
}
