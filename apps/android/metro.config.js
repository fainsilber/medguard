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

module.exports = config;
