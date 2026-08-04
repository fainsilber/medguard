import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;
const isCI = !!process.env.CI;

const API_PORT = 8787;
const API_URL = `http://localhost:${API_PORT}`;

/**
 * E2E runs against a production build, not the dev server, so the real service worker and the
 * real precache manifest are what gets exercised.
 *
 * Most specs stub `apps/api` via `page.route()` — proven separately against the real workerd
 * runtime in `apps/api/tests/`, and stubbing keeps most of this suite hermetic and fast. Sprint 4's
 * live-sync spec is the one exception: a WebSocket connection can't be intercepted by
 * `page.route()`, so proving real-time propagation between two devices needs a real `wrangler dev`
 * running alongside the web preview — hence the second `webServer` entry below. Local D1 is
 * migrated first so a fresh checkout (CI, in particular) isn't missing tables the first time this
 * runs.
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

  webServer: [
    {
      command: 'npm run build --workspace=@medguard/web && npm run preview --workspace=@medguard/web',
      url: BASE_URL,
      reuseExistingServer: !isCI,
      timeout: 120_000,
    },
    {
      command:
        'npm run db:migrate:local --workspace=@medguard/api && npm run dev --workspace=@medguard/api',
      url: `${API_URL}/api/v1/health`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
});
