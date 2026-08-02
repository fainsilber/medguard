import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;
const isCI = !!process.env.CI;

/**
 * E2E runs against a production build, not the dev server, so the real service worker and the
 * real precache manifest are what gets exercised.
 *
 * Sprint 4 adds a second browser context to this setup to stand in for a second caregiver's
 * phone, and asserts the PRD's 1.5s cross-device broadcast budget.
 */
export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 1 : undefined,
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    // Push and notification tests in Sprint 5 need these granted up front.
    permissions: ['notifications'],
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    command: 'npm run build --workspace=@medguard/web && npm run preview --workspace=@medguard/web',
    url: BASE_URL,
    reuseExistingServer: !isCI,
    timeout: 120_000,
  },
});
