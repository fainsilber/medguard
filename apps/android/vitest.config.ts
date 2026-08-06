import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('../../packages/shared/src', import.meta.url));
const storeSrc = fileURLToPath(new URL('../../packages/store/src', import.meta.url));

/**
 * Scoped to plain TypeScript (runtime, alarm materialization) — no RN components. Per
 * docs/android-client-plan.md's test strategy table, RN UI specs run under Jest +
 * @testing-library/react-native (added from Sprint A2), not vitest; this project only proves
 * the platform-free logic this app adds on top of `@medguard/shared`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@medguard/shared/testing': `${sharedSrc}/testing.ts`,
      '@medguard/shared': `${sharedSrc}/index.ts`,
      '@medguard/store/sqlite': `${storeSrc}/sqlite/index.ts`,
      '@medguard/store/testing': `${storeSrc}/testing/index.ts`,
      '@medguard/store': `${storeSrc}/index.ts`,
    },
  },
  test: {
    name: 'android',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**', '.expo/**'],
  },
});
