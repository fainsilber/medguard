// Metro in a monorepo is the known friction point (docs/android-client-plan.md,
// "Metro in a monorepo"). This app is one of several npm workspaces, and it consumes
// `@medguard/shared` straight from TypeScript source — no build step — the same way Vite and
// workerd already do, so Metro has to be told where the rest of the repo and its hoisted
// `node_modules` live.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole repo, not just this workspace, so edits to packages/shared trigger a
// Fast Refresh instead of a stale bundle.
config.watchFolders = [workspaceRoot];

// Resolve modules from this app's own node_modules first, then fall back to the hoisted
// root node_modules that npm workspaces installs into.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// @medguard/shared's package.json declares an "exports" map ("." and "./testing") rather than
// a single "main" field — required so Metro resolves it the same way Vite and workerd do.
config.resolver.unstable_enablePackageExports = true;

// packages/shared's package.json sets "type": "module", and real Node ESM requires an explicit
// extension on every relative import — so every file in packages/shared writes
// `from './clock.js'` etc. even though the file on disk is `clock.ts`. Vite, workerd and
// vitest's Node resolver all understand that convention; Metro's resolver does not — it treats
// an explicit extension as literal and never retries against sourceExts, so it fails to resolve
// "./clock.js" with "None of these files exist". This is the specific shape "Metro in a
// monorepo" (docs/android-client-plan.md) turned out to take once tried on a real device: retry
// a ".js"-suffixed relative specifier against ".ts"/".tsx" before giving up.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    for (const ext of ['.ts', '.tsx']) {
      try {
        return context.resolveRequest(context, moduleName.replace(/\.js$/, ext), platform);
      } catch {
        // No sibling with this extension — try the next one, then fall through below.
      }
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
