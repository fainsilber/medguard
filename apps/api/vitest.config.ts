import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { TEST_SERVICE_ACCOUNT_JSON } from './tests/fcmTestKey.js';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));
const migrationsDir = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Runs the API tests inside the real workerd runtime with real D1 and real Durable Objects,
 * locally and with no Cloudflare account. This is what makes the backend testable unattended.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          // Handed to the setup file, which applies them into each test's isolated D1.
          TEST_MIGRATIONS: await readD1Migrations(migrationsDir),

          // A throwaway keypair generated solely for tests, so the push path is exercised in
          // CI where no .dev.vars exists. These are not used anywhere real: outbound fetch is
          // intercepted, so nothing is ever sent to a push service.
          VAPID_SUBJECT: 'mailto:test@medguard.invalid',
          VAPID_PUBLIC_KEY:
            'BH7wRMtDhX-_fcWE9FIRJC7yH7h9sFYekB5i6XMYh8EuXcr013vn7x0sS9Mv2UtVkLaQ4DiwljYTS715xigo_lM',
          VAPID_PRIVATE_KEY: 'DpbCd7ViYjhEg68WPbhMF7Dj9ERMmJmPG8TM16BPEkw',

          // Sprint A4. Same reasoning as the VAPID keypair above: a throwaway service account so
          // the FCM half of the fan-out is exercised in CI, where no Firebase project exists.
          FCM_SERVICE_ACCOUNT: TEST_SERVICE_ACCOUNT_JSON,
        },
      },
    })),
  ],
  resolve: {
    alias: {
      '@medguard/shared/testing': `${sharedSrc}/testing.ts`,
      '@medguard/shared': `${sharedSrc}/index.ts`,
    },
  },
  test: {
    name: 'api',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./tests/applyMigrations.ts'],
  },
});
