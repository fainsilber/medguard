import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

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
        // Handed to the setup file, which applies them into each test's isolated D1.
        bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir) },
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
