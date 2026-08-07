import type { ExpoConfig } from 'expo/config';

/**
 * Continuous native generation: no committed `android/` directory. Every manifest entry the
 * alarm layer needs is owned by `./plugins/withMedGuardAlarms`, in one reviewable TypeScript
 * file, rather than hand-edited into generated output that the next `expo prebuild` would
 * silently discard (docs/android-client-plan.md, "Framework and workspace").
 */
const config: ExpoConfig = {
  name: 'MedGuard',
  slug: 'medguard',
  scheme: 'medguard',
  owner: 'medguard',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  platforms: ['android'],
  // Same Star of Life mark as apps/web/public/icons (icon-512*.png) — without this,
  // `expo prebuild` falls back to the stock Expo/Android launcher icon.
  icon: './assets/icon.png',
  android: {
    package: 'com.medguard.app',
    // Android's auto-backup would otherwise copy the on-device dosing history into the
    // user's Google Drive by default (docs/android-client-plan.md, "data-handling
    // requirements"; docs/data-handling.md). The plugin also sets explicit
    // dataExtractionRules so this can't be silently re-enabled by a template update.
    allowBackup: false,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0a0e17',
    },
  },
  plugins: ['./plugins/withMedGuardAlarms'],
  extra: {
    // Overridden per-build (dev/staging/prod) via EAS build profiles in eas.json.
    apiBaseUrl: process.env.MEDGUARD_API_BASE_URL ?? 'https://medguard-api.example.workers.dev',
  },
};

export default config;
