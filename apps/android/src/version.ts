import { nativeBuildVersion } from 'expo-application';
import Constants from 'expo-constants';

/**
 * Build-time identity — mirrors apps/web/src/version.ts's `APP_VERSION`/`BUILD_TIME` for the same
 * reason: an installed build (most often a sideloaded APK from
 * .github/workflows/android-apk.yml, which has no EAS remote-version tracking) needs to be
 * identifiable from the device alone. `gitSha`/`buildTimestamp` come from app.config.ts's `extra`,
 * baked in at `expo prebuild` time; `nativeBuildVersion` comes from the installed package's own
 * manifest via expo-application, independent of the JS bundle.
 */
const extra = Constants.expoConfig?.extra as
  | { gitSha?: string; buildTimestamp?: string }
  | undefined;

export const APP_VERSION = Constants.expoConfig?.version ?? 'dev';
export const GIT_SHA = extra?.gitSha ?? 'unknown';
export const BUILD_TIME = extra?.buildTimestamp ?? null;
export const NATIVE_BUILD_VERSION = nativeBuildVersion;
