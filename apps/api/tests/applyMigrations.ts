import { applyD1Migrations, env } from 'cloudflare:test';

/**
 * Each test file gets isolated storage, so migrations are applied per run rather than once
 * globally. This also means the migrations themselves are exercised on every test run — a
 * broken migration fails the suite rather than surfacing at deploy time.
 */
if (!env.TEST_MIGRATIONS) {
  throw new Error('TEST_MIGRATIONS binding missing — check the miniflare bindings in vitest.config.ts');
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
