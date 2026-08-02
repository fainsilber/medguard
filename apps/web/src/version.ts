/**
 * Build-time identity — the git commit deployed, and when the build ran. See vite.config.ts.
 *
 * Deliberately not under src/probe/: unlike that folder, this is a permanent app-shell concern,
 * not throwaway Sprint 0 diagnostic tooling — it stays useful for every future deploy, not just
 * this one.
 *
 * `typeof` is the one operator that never throws on an undeclared identifier, so this resolves
 * safely to the fallback under `vite dev` (no production define) and under vitest (no Vite
 * bundling at all), and to the real baked-in value in a production build.
 */
declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

export const APP_VERSION = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__;
export const BUILD_TIME = typeof __BUILD_TIME__ === 'undefined' ? null : __BUILD_TIME__;
