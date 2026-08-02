/**
 * Test-only bindings, merged into the generated `Cloudflare.Env`.
 *
 * Everything declared in wrangler.jsonc comes from worker-configuration.d.ts (regenerate with
 * `npm run cf-typegen` after changing bindings). TEST_MIGRATIONS exists only under Miniflare,
 * supplied by vitest.config.ts, so it is declared here rather than there.
 */
declare namespace Cloudflare {
  interface Env {
    // Optional so the generated `Env` stays assignable to `Cloudflare.Env` in src/, where this
    // binding does not exist. The test setup file asserts its presence at runtime.
    TEST_MIGRATIONS?: { name: string; queries: string[] }[];
  }
}
