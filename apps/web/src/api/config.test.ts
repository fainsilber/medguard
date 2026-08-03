import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `DEFAULT_API_BASE_URL` is computed once, at import time, from `location.hostname` and
 * `import.meta.env.VITE_API_BASE_URL` — exactly the pattern that makes the default right in
 * production and awkward to test. `vi.resetModules()` plus a dynamic import gives each test a
 * fresh module instance evaluated under whatever hostname/env we set up first.
 */
async function loadWithHostname(hostname: string) {
  vi.stubGlobal('location', { ...window.location, hostname });
  const module = await import('./config.js');
  return module;
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
});

describe('DEFAULT_API_BASE_URL', () => {
  it('points at the local dev server when running on localhost', async () => {
    const { DEFAULT_API_BASE_URL } = await loadWithHostname('localhost');
    expect(DEFAULT_API_BASE_URL).toBe('http://localhost:8787');
  });

  it('points at the local dev server on the 127.0.0.1 loopback address too', async () => {
    const { DEFAULT_API_BASE_URL } = await loadWithHostname('127.0.0.1');
    expect(DEFAULT_API_BASE_URL).toBe('http://localhost:8787');
  });

  it('points at the real deployed API for any other host — the production default', async () => {
    // This is the case that was wrong: nothing in the build pipeline sets VITE_API_BASE_URL, so a
    // caregiver's actual phone hitting the deployed PWA used to inherit the localhost default and
    // could never reach the API — which the clock-skew guard then reported as merely
    // "unverified," never as an obvious error.
    const { DEFAULT_API_BASE_URL } = await loadWithHostname('medguard-web.fainsilber.workers.dev');
    expect(DEFAULT_API_BASE_URL).toBe('https://medguard-api.fainsilber.workers.dev');
  });

  it('defers to an explicit build-time override over any hostname default', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://staging.example.com');
    const { DEFAULT_API_BASE_URL } = await loadWithHostname('medguard-web.fainsilber.workers.dev');
    expect(DEFAULT_API_BASE_URL).toBe('https://staging.example.com');
  });
});

describe('getApiBaseUrl / setApiBaseUrl', () => {
  it('falls back to the default when no override has been set', async () => {
    const { getApiBaseUrl, DEFAULT_API_BASE_URL } = await loadWithHostname('localhost');
    expect(getApiBaseUrl()).toBe(DEFAULT_API_BASE_URL);
  });

  it('returns a caregiver-set override in preference to the default', async () => {
    const { getApiBaseUrl, setApiBaseUrl } = await loadWithHostname('localhost');
    setApiBaseUrl('https://staging.example.com');
    expect(getApiBaseUrl()).toBe('https://staging.example.com');
  });

  it('trims whitespace and a trailing slash, so a pasted URL still matches route paths exactly', async () => {
    const { getApiBaseUrl, setApiBaseUrl } = await loadWithHostname('localhost');
    setApiBaseUrl('  https://staging.example.com/  ');
    expect(getApiBaseUrl()).toBe('https://staging.example.com');
  });

  it('clears back to the default when set to an empty value', async () => {
    const { getApiBaseUrl, setApiBaseUrl, DEFAULT_API_BASE_URL } = await loadWithHostname('localhost');
    setApiBaseUrl('https://staging.example.com');
    setApiBaseUrl('   ');
    expect(getApiBaseUrl()).toBe(DEFAULT_API_BASE_URL);
  });
});
