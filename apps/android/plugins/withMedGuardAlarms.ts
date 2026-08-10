import type { ConfigPlugin } from 'expo/config-plugins';
import {
  AndroidConfig,
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  withProjectBuildGradle,
} from 'expo/config-plugins';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every manifest entry the alarm layer needs, in one reviewable file
 * (docs/android-client-plan.md, "Framework and workspace"). With continuous native generation
 * (no committed `android/` directory) this is what survives `expo prebuild` — hand-editing the
 * generated manifest would be silently discarded on the next prebuild.
 */
const PERMISSIONS = [
  // Exact dose alarms (docs/android-client-plan.md, "Scheduling"). USE_EXACT_ALARM is
  // install-time on API 33+ but Play-reviewed (AD4); SCHEDULE_EXACT_ALARM covers API 31-32 via
  // a runtime prompt.
  'android.permission.USE_EXACT_ALARM',
  'android.permission.SCHEDULE_EXACT_ALARM',
  // Re-arming after a reboot (AD7, "Re-arming").
  'android.permission.RECEIVE_BOOT_COMPLETED',
  // Required to post any notification on API 33+.
  'android.permission.POST_NOTIFICATIONS',
  // DND bypass for escalation, granted by the user via a settings deep link, never silently
  // (AD7, "Channels").
  'android.permission.ACCESS_NOTIFICATION_POLICY',
  // The chime's foreground service.
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  // Sprint A4's headless drain (`MedGuardHeadlessService`). Android 14+ requires a permission
  // per foreground-service *type*, and without this one the service throws on start — which
  // would silently lose the lock-screen tap it exists to rescue.
  'android.permission.FOREGROUND_SERVICE_SHORT_SERVICE',
  // Battery-optimization exemption prompt (AD7, onboarding checklist).
  'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
  // Escalation-only, and only usable when canUseFullScreenIntent() says so at runtime (AD4).
  'android.permission.USE_FULL_SCREEN_INTENT',
] as const;

const DATA_EXTRACTION_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<!--
  Explicit dataExtractionRules (Android 12+), alongside android:allowBackup="false" set via
  app.config.ts's android.allowBackup. Without this, Android's auto-backup would copy the
  on-device SQLite database, a child's complete dosing history, into the user's Google
  Drive, silently and by default (docs/android-client-plan.md, "data-handling requirements";
  docs/data-handling.md).
-->
<data-extraction-rules>
  <cloud-backup disableIfNoEncryptionCapability="true">
    <exclude domain="database" />
    <exclude domain="sharedpref" />
    <exclude domain="file" />
  </cloud-backup>
  <device-transfer>
    <exclude domain="database" />
    <exclude domain="sharedpref" />
    <exclude domain="file" />
  </device-transfer>
</data-extraction-rules>
`;

/** Pre-Android-12 equivalent of dataExtractionRules; harmless to include, ignored on 12+. */
const LEGACY_BACKUP_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
  <exclude domain="database" />
  <exclude domain="sharedpref" />
  <exclude domain="file" />
</full-backup-content>
`;

const withDataExtractionResources: ConfigPlugin = (config) =>
  withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const xmlDir = path.join(modConfig.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'data_extraction_rules.xml'), DATA_EXTRACTION_RULES_XML);
      fs.writeFileSync(path.join(xmlDir, 'backup_rules.xml'), LEGACY_BACKUP_RULES_XML);
      return modConfig;
    },
  ]);

const withAlarmManifestEntries: ConfigPlugin = (config) =>
  withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults;
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);

    application.$['android:dataExtractionRules'] = '@xml/data_extraction_rules';
    application.$['android:fullBackupContent'] = '@xml/backup_rules';

    application.receiver = application.receiver ?? [];
    application.service = application.service ?? [];

    const pkg = config.android?.package;
    if (!pkg) {
      throw new Error('withMedGuardAlarms requires android.package to be set in app.config.ts');
    }

    application.receiver.push(
      {
        $: {
          'android:name': 'com.medguard.alarms.AlarmReceiver',
          'android:enabled': 'true' as unknown as boolean,
          'android:exported': 'false' as unknown as boolean,
        },
      } as never,
      {
        $: {
          'android:name': 'com.medguard.alarms.NotificationActionReceiver',
          'android:enabled': 'true' as unknown as boolean,
          'android:exported': 'false' as unknown as boolean,
        },
      } as never,
      {
        $: {
          'android:name': 'com.medguard.alarms.BootReceiver',
          'android:enabled': 'true' as unknown as boolean,
          'android:exported': 'true' as unknown as boolean,
          'android:directBootAware': 'true' as unknown as boolean,
        },
        'intent-filter': [
          {
            action: [
              { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
              { $: { 'android:name': 'android.intent.action.LOCKED_BOOT_COMPLETED' } },
              { $: { 'android:name': 'android.intent.action.MY_PACKAGE_REPLACED' } },
              { $: { 'android:name': 'android.intent.action.TIME_SET' } },
              { $: { 'android:name': 'android.intent.action.TIMEZONE_CHANGED' } },
            ],
          },
        ],
      } as never,
    );

    application.service.push(
      {
        $: {
          'android:name': 'com.medguard.alarms.DoseAlarmService',
          'android:enabled': 'true' as unknown as boolean,
          'android:exported': 'false' as unknown as boolean,
          // Not "dataSync" or "mediaProcessing": Android 15 caps those at six hours per 24h.
          // A 45-second chime is exactly the case "mediaPlayback" exists for
          // (docs/android-client-plan.md, "The chime").
          'android:foregroundServiceType': 'mediaPlayback',
        },
      } as never,
      {
        // Sprint A4: the headless JS runtime that converts a lock-screen tap into a dose when the
        // app process is dead. "shortService" is the type for exactly this — a brief, bounded
        // piece of work the user just asked for — and it is not subject to Android 15's six-hour
        // cap because it cannot run long enough to reach it.
        $: {
          'android:name': 'com.medguard.alarms.MedGuardHeadlessService',
          'android:enabled': 'true' as unknown as boolean,
          'android:exported': 'false' as unknown as boolean,
          'android:foregroundServiceType': 'shortService',
        },
      } as never,
    );

    if (hasGoogleServicesFile(config)) {
      application.service.push({
        // Registered only when there is a Firebase project to talk to. Declaring the service
        // without `google-services.json` would leave a receiver Firebase can never initialise.
        $: {
          'android:name': 'com.medguard.alarms.MedGuardMessagingService',
          'android:enabled': 'true' as unknown as boolean,
          'android:exported': 'false' as unknown as boolean,
        },
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }],
          },
        ],
      } as never);
    }

    return modConfig;
  });

/**
 * Firebase Cloud Messaging (Sprint A4) is wired in **only when a `google-services.json` is
 * present**, and everything below it degrades honestly when it isn't.
 *
 * This is deliberate, not a shortcut. The household's local alarms are the primary mechanism and
 * need no Firebase project at all; the server push is a backstop. Making Firebase mandatory would
 * mean the sideloadable APK (`.github/workflows/android-apk.yml`, which builds on a GitHub-hosted
 * runner with no secrets) could no longer be built by anyone who has not first created a Firebase
 * project — trading a working build for a feature that only matters once the API also has a
 * service-account secret. With the file absent, `getPushToken()` returns null, the device
 * registers no push credential, and `alarmHealth` reports that the server backstop is unavailable
 * rather than pretending it is there.
 */
function hasGoogleServicesFile(config: Parameters<ConfigPlugin>[0]): boolean {
  const declared = config.android?.googleServicesFile;
  if (declared) {
    return fs.existsSync(path.resolve(process.cwd(), declared));
  }
  return fs.existsSync(path.resolve(process.cwd(), 'google-services.json'));
}

/** The Google Services Gradle plugin, which is what turns `google-services.json` into a config. */
const withFirebaseGradle: ConfigPlugin = (config) => {
  let result = withProjectBuildGradle(config, (modConfig) => {
    if (
      modConfig.modResults.language === 'groovy' &&
      !modConfig.modResults.contents.includes('com.google.gms:google-services')
    ) {
      modConfig.modResults.contents = modConfig.modResults.contents.replace(
        /dependencies\s*{/,
        (match) => `${match}\n        classpath('com.google.gms:google-services:4.4.2')`,
      );
    }
    return modConfig;
  });

  result = withAppBuildGradle(result, (modConfig) => {
    const { contents } = modConfig.modResults;
    if (modConfig.modResults.language !== 'groovy') {
      return modConfig;
    }
    if (!contents.includes("apply plugin: 'com.google.gms.google-services'")) {
      modConfig.modResults.contents = `${contents}\napply plugin: 'com.google.gms.google-services'\n`;
    }
    if (!modConfig.modResults.contents.includes('firebase-messaging')) {
      modConfig.modResults.contents = modConfig.modResults.contents.replace(
        /dependencies\s*{/,
        (match) => `${match}\n    implementation("com.google.firebase:firebase-messaging:24.0.0")`,
      );
    }
    return modConfig;
  });

  return result;
};

const withMedGuardAlarms: ConfigPlugin = (config) => {
  let result = config;
  result = AndroidConfig.Permissions.withPermissions(result, [...PERMISSIONS]);
  result = withAlarmManifestEntries(result);
  result = withDataExtractionResources(result);
  if (hasGoogleServicesFile(config)) {
    result = withFirebaseGradle(result);
  }
  return result;
};

export default withMedGuardAlarms;
