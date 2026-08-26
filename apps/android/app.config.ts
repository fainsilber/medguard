import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ExpoConfig } from 'expo/config';

/**
 * Baked into `extra` so an installed build can be identified from the device alone — same reason
 * and same fallback-on-failure as apps/web/vite.config.ts's `gitShortSha`. This matters most for
 * the plain-Gradle CI build (.github/workflows/android-apk.yml), which has no EAS remote-version
 * tracking (eas.json's `appVersionSource: "remote"` only applies to EAS builds) and no other way
 * to tell two sideloaded APKs apart.
 */
function gitShortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return 'unknown';
  }
}

/**
 * The path to `google-services.json` when a Firebase project has been configured, `undefined`
 * otherwise.
 *
 * Two separate things read this file and both have to agree, which is why it is stated here
 * rather than left implicit:
 *
 *  - `plugins/withMedGuardAlarms.ts` uses its presence to decide whether to apply the Google
 *    Services Gradle plugin and the `firebase-messaging` dependency at all.
 *  - Expo's own `withGoogleServicesFile` base mod is what actually *copies* the file into the
 *    generated `android/app/`, and it only runs when `android.googleServicesFile` is set. Leave
 *    it unset and prebuild produces a project that applies `com.google.gms.google-services`
 *    with no JSON for it to read, so `assembleRelease` dies with "File google-services.json is
 *    missing" — the Firebase-enabled build fails outright while the file sits one directory up.
 *
 * Conditional rather than a constant because declaring a path to a file that isn't there makes
 * prebuild throw, and "no Firebase project" is a supported state everywhere else in this app
 * (see the long comment on `hasGoogleServicesFile` in the plugin). Resolved against this config's
 * own directory, not `process.cwd()`, so the answer doesn't depend on where prebuild was invoked
 * from.
 */
function resolveGoogleServicesFile(): string | undefined {
  const relativePath = './google-services.json';
  return fs.existsSync(path.resolve(__dirname, relativePath)) ? relativePath : undefined;
}

const googleServicesFile = resolveGoogleServicesFile();

/**
 * Continuous native generation: no committed `android/` directory. Every manifest entry the
 * alarm layer needs is owned by `./plugins/withMedGuardAlarms`, in one reviewable TypeScript
 * file, rather than hand-edited into generated output that the next `expo prebuild` would
 * silently discard (docs/android-client-plan.md, "Framework and workspace").
 */
const config: ExpoConfig = {
  name: 'MedGuard',
  slug: 'med',
  scheme: 'medguard',
  owner: 'fainsilber.co.il',
  version: '2.0.1',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  platforms: ['android'],
  // Same Star of Life mark as apps/web/public/icons (icon-512*.png) — without this,
  // `expo prebuild` falls back to the stock Expo/Android launcher icon.
  icon: './assets/icon.png',
  android: {
    package: 'il.co.fainsilber.med',
    // Spread, not `googleServicesFile: …` — `exactOptionalPropertyTypes` rejects an explicit
    // `undefined` on an optional property, and leaving the key off entirely is what Expo wants
    // for the no-Firebase build regardless.
    ...(googleServicesFile ? { googleServicesFile } : {}),
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
  plugins: [
    './plugins/withMedGuardAlarms',
    [
      'expo-splash-screen',
      {
        // Same Star of Life mark as the app/adaptive icon, isolated onto a transparent
        // background so it sits on `backgroundColor` without the icon's square edges showing.
        image: './assets/splash-icon.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: '#0a0e17',
      },
    ],
  ],
  extra: {
    // Overridden per-build (dev/staging/prod) via EAS build profiles in eas.json. Left `undefined`
    // when unset (e.g. the plain-Gradle CI build, which sets no env vars at all) rather than
    // hardcoding a fallback here — `src/api/config.ts`'s own `DEFAULT_API_BASE_URL` already
    // falls back to the real deployed API, and duplicating that URL in two places is exactly how
    // this drifted to a placeholder `*.example.workers.dev` host that doesn't resolve, silently
    // breaking every network call in a build nobody had run on a real device yet.
    apiBaseUrl: process.env.MEDGUARD_API_BASE_URL,
    gitSha: gitShortSha(),
    buildTimestamp: new Date().toISOString(),
    eas: {
      projectId: '6c286d6d-38b3-4eb5-b87d-ceb533854120',
    },
  },
};

export default config;
