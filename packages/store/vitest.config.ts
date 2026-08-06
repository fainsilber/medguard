import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const sharedSrc = fileURLToPath(new URL('../shared/src', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@medguard/shared/testing': `${sharedSrc}/testing.ts`,
      '@medguard/shared': `${sharedSrc}/index.ts`,
    },
  },
  test: {
    name: 'store',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules/**'],
  },
});
