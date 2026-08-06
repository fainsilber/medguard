import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));
const storeSrc = fileURLToPath(new URL('../../packages/store/src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@medguard/shared/testing': `${sharedSrc}/testing.ts`,
      '@medguard/shared': `${sharedSrc}/index.ts`,
      '@medguard/store/dexie': `${storeSrc}/dexie/index.ts`,
      '@medguard/store': `${storeSrc}/index.ts`,
    },
  },
  test: {
    name: 'web',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
    // Playwright owns e2e; vitest must not try to run those specs.
    exclude: ['e2e/**', 'node_modules/**'],
  },
});
