/**
 * Where the API lives.
 *
 * Resolution order: an explicit build-time override, then a caregiver-set runtime override
 * (useful for pointing a phone at a laptop's `wrangler dev` on the same network), then a default
 * chosen by where the page itself is running.
 *
 * That last fallback matters more than it looks. It used to be a bare `http://localhost:8787`
 * regardless of context — correct for local dev, but nothing in the build or deploy pipeline
 * ever sets `VITE_API_BASE_URL` for the production build, so the deployed PWA silently inherited
 * that same localhost default on a caregiver's actual phone, where it can never succeed. The
 * failure was quiet by design: `useClockTrust` treats an unreachable server as `unverified` and
 * fails closed (safety invariant 3), so this didn't crash or log anything — it just left the PRN
 * screen permanently blocked, which is exactly the kind of default that has to be right rather
 * than merely reasonable for the common case.
 */
const OVERRIDE_STORAGE_KEY = 'medguard-api-base-url';

const LOCAL_API_BASE_URL = 'http://localhost:8787';

/** The one production API deployment. Update here if it's ever renamed or moved. */
const PRODUCTION_API_BASE_URL = 'https://medguard-api.fainsilber.workers.dev';

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

export const DEFAULT_API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  (isLocalhost(location.hostname) ? LOCAL_API_BASE_URL : PRODUCTION_API_BASE_URL);

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
