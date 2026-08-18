#!/usr/bin/env bash
# Drives ../.maestro/boot-rearm.yaml, then does the half of the flow Maestro itself has no command
# for: firing a BOOT_COMPLETED broadcast at BootReceiver and checking AlarmManager for evidence it
# re-armed — then cancels that alarm before handing off. The cancel step isn't just tidiness: this
# script's alarm is armed for a real 15s AlarmManager trigger, alarm-action.sh runs immediately
# after this script, and an alarm left ticking fires mid-way through alarm-action.sh's own
# kill-the-process test, resurrecting the app and corrupting that test's "process is dead" premise
# (see the cancel step below for the full story — found the hard way in CI). See docs/testing.md
# for prerequisites (an already-installed APK, `maestro` and `adb` on PATH, a running
# emulator/device).
#
# Usage: apps/android/e2e/boot-rearm.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_ID="il.co.fainsilber.med"
RECEIVER="$APP_ID/com.medguard.alarms.BootReceiver"

echo "== Arming a real AlarmManager alarm via Settings =="
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

echo "== Cancelling the re-armed test alarm so it can't fire later =="
# Confirmed the hard way in CI: this alarm is still armed for ~11s more at this point (armed 15s
# out, and only ~4s have elapsed). Left alone, it fires mid-way through alarm-action.sh — which
# runs immediately after this script — and resurrects the app's process via DoseAlarmService's
# notification right before alarm-action.sh kills the process and broadcasts a Taken action of its
# own. That resurrected process has a live JS runtime, so NotificationActionReceiver's
# hasLiveRuntime() branch fires instead of the headless-service branch the test exists to exercise,
# and the tap gets handled and acked (by the live JS listener) in milliseconds — before
# alarm-action.sh's own "captured durably" check ever runs, making it look like the tap was never
# captured at all. Cancelling here removes both the AlarmManager entry and the ArmedAlarmStore
# entry (AlarmScheduler.cancel()), so nothing is left to fire.
maestro test e2e/maestro-subflows/cancel-armed-alarm.yaml
