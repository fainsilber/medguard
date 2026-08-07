import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

/**
 * Where the API lives — the Android equivalent of `apps/web/src/api/config.ts`.
 *
 * The build-time base URL comes from `app.config.ts`'s `extra.apiBaseUrl` (set per EAS build
 * profile, exposed at runtime through `expo-constants`) rather than `import.meta.env` — there is
 * no bundler-injected env var on this platform. The runtime override (for pointing a phone at a
 * laptop's `wrangler dev` on the same network) is persisted with `expo-secure-store`, which has
 * no synchronous read — so unlike web, the override has to be loaded once at startup
 * (`loadApiBaseUrlOverride`, called from `app/RepositoryContext.tsx`) into an in-memory cache
 * that `getApiBaseUrl()` then reads synchronously, matching every other call site's expectation
 * (`SyncEngine`, `householdApi.ts` — all take `apiBaseUrl` as a plain string).
 */
const OVERRIDE_STORAGE_KEY = 'medguard-api-base-url';

export const DEFAULT_API_BASE_URL: string =
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ??
  'https://medguard-api.fainsilber.workers.dev';

let cachedOverride: string | null = null;

/** Must be awaited once before the first `getApiBaseUrl()` call — see `RepositoryContext.tsx`. */
export async function loadApiBaseUrlOverride(): Promise<void> {
  cachedOverride = await SecureStore.getItemAsync(OVERRIDE_STORAGE_KEY);
}

export function getApiBaseUrl(): string {
  return cachedOverride ?? DEFAULT_API_BASE_URL;
}

export async function setApiBaseUrl(url: string): Promise<void> {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) {
    cachedOverride = null;
    await SecureStore.deleteItemAsync(OVERRIDE_STORAGE_KEY);
    return;
  }
  cachedOverride = trimmed;
  await SecureStore.setItemAsync(OVERRIDE_STORAGE_KEY, trimmed);
}
