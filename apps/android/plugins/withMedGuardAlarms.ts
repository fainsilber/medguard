import type { ConfigPlugin } from 'expo/config-plugins';
import { AndroidConfig, withAndroidManifest, withDangerousMod } from 'expo/config-plugins';
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

    application.service.push({
      $: {
        'android:name': 'com.medguard.alarms.DoseAlarmService',
        'android:enabled': 'true' as unknown as boolean,
        'android:exported': 'false' as unknown as boolean,
        // Not "dataSync" or "mediaProcessing": Android 15 caps those at six hours per 24h.
        // A 45-second chime is exactly the case "mediaPlayback" exists for
        // (docs/android-client-plan.md, "The chime").
        'android:foregroundServiceType': 'mediaPlayback',
      },
    } as never);

    return modConfig;
  });

const withMedGuardAlarms: ConfigPlugin = (config) => {
  let result = config;
  result = AndroidConfig.Permissions.withPermissions(result, [...PERMISSIONS]);
  result = withAlarmManifestEntries(result);
  result = withDataExtractionResources(result);
  return result;
};

export default withMedGuardAlarms;
