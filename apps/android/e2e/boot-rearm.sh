#!/usr/bin/env bash
# Drives ../.maestro/boot-rearm.yaml, then does the half of the flow Maestro itself has no command
# for: firing a BOOT_COMPLETED broadcast at BootReceiver and checking AlarmManager for evidence it
# re-armed. See docs/testing.md for prerequisites (an already-installed APK, `maestro` and `adb` on
# PATH, a running emulator/device).
#
# Usage: apps/android/e2e/boot-rearm.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_ID="il.co.fainsilber.med"
RECEIVER="$APP_ID/com.medguard.alarms.BootReceiver"

echo "== Arming a real AlarmManager alarm via Diagnostics =="
maestro test .maestro/boot-rearm.yaml

echo "== Simulating a reboot: broadcasting BOOT_COMPLETED at $RECEIVER =="
# BootReceiver is android:exported="true" (plugins/withMedGuardAlarms.ts) specifically so this is
# reachable from the shell UID — no adb root needed for this flow, unlike alarm-action.sh.
adb shell am broadcast -a android.intent.action.BOOT_COMPLETED -n "$RECEIVER"

# BootReceiver re-arms asynchronously off the main thread (re-reading ArmedAlarmStore and calling
# AlarmManager for each entry); give it a moment before checking.
sleep 2

echo "== Checking AlarmManager for a re-armed alarm =="
if adb shell dumpsys alarm | grep -q "$APP_ID"; then
  echo "PASS: AlarmManager has an alarm for $APP_ID after BOOT_COMPLETED — BootReceiver re-armed it."
else
  echo "FAIL: no AlarmManager entry for $APP_ID found after BOOT_COMPLETED." >&2
  exit 1
fi
