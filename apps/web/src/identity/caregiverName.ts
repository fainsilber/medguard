/**
 * Which caregiver is using this device.
 *
 * This is deliberately not authentication — there is no password, no server account, and
 * nothing stops someone from typing any name. It exists purely to satisfy safety invariant 5
 * (every log records who and when — no anonymous entries) on a single offline device, before
 * Sprint 3 adds real join-code accounts shared across a household. Once that lands, this local
 * name is replaced by the authenticated caregiver's identity; nothing downstream needs to
 * change, since both ultimately just produce a `UserId` string.
 */
const STORAGE_KEY = 'medguard-caregiver-name';

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

export function clearCaregiverName(): void {
  localStorage.removeItem(STORAGE_KEY);
}
