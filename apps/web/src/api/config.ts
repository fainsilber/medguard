/**
 * Where the API lives.
 *
 * Baked in at build time for production and overridable at runtime for development, so a phone on
 * the same network can point at a laptop's `wrangler dev` without a rebuild. The Sprint 0 probe
 * screen has its own override for the same reason and predates this; both read the same default.
 */
const OVERRIDE_STORAGE_KEY = 'medguard-api-base-url';

export const DEFAULT_API_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8787';

export function getApiBaseUrl(): string {
  return localStorage.getItem(OVERRIDE_STORAGE_KEY) ?? DEFAULT_API_BASE_URL;
}

export function setApiBaseUrl(url: string): void {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) {
    localStorage.removeItem(OVERRIDE_STORAGE_KEY);
    return;
  }
  localStorage.setItem(OVERRIDE_STORAGE_KEY, trimmed);
}
