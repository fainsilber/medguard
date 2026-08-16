#!/usr/bin/env bash
# Drives ../.maestro/alarm-notification-action.yaml, then exercises the part no Maestro command
# reaches: force-stopping the app and broadcasting a notification action directly at
# NotificationActionReceiver, the way a real locked-phone tap would arrive with the process dead.
#
# Read this whole comment before trusting a green run. What this proves and what it doesn't is
# deliberately narrow:
#
#   - NotificationActionReceiver is android:exported="false" (plugins/withMedGuardAlarms.ts), so
#     `am broadcast -n` from the plain shell UID gets "Permission Denial". This requires `adb
#     root` first (root is exempt) and a `google_apis` system image (not `google_play`, which
#     isn't rootable) — see docs/testing.md for the emulator setup this needs.
#   - The alarm armed by the Maestro flow comes from Diagnostics' "Locked-phone dry run" card
#     (DiagnosticsScreen.tsx), which arms a real AlarmManager alarm through the exact same
#     scheduleDoseAlarm() path a due dose uses — but its occurrenceKey is a bare
#     `Crypto.randomUUID()`, not the `${scheduleId}:${dueAt}` shape a real schedule occurrence
#     has (packages/store/src/pendingActions.ts). NotificationActionReceiver doesn't care — it
#     records intent unconditionally — but the JS-side drain's `resolveOccurrence()` can't find a
#     matching schedule for it, logs "no occurrence for a captured action", and acks the tap
#     without writing an IntakeLog. That is expected and correct for this synthetic key, NOT a
#     bug: a caregiver's real tap always carries a real schedule's occurrenceKey.
#   - What this script asserts instead: the tap is captured durably (PendingActionStore's
#     SharedPreferences has a non-empty "entries" array immediately after the broadcast, even
#     though the app process is dead) and drained cleanly by the headless path (the same file is
#     back to "[]" a few seconds later, and the app relaunches without crashing). That is the
#     round trip safety invariant 7 exists for — captured before it can be lost, applied without
#     needing the app to be reopened — proven through the real BroadcastReceiver ->
#     foreground-service -> headless-JS chain, not a unit test's mocks.
#   - It does NOT assert an IntakeLog was written or that inventory moved — see offline-smoke.yaml
#     for that assertion, made through the UI on a dose that IS a real occurrence.
#
# Usage: apps/android/e2e/alarm-action.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

APP_ID="il.co.fainsilber.med"
RECEIVER="$APP_ID/com.medguard.alarms.NotificationActionReceiver"
ARMED_PREFS="/data/data/$APP_ID/shared_prefs/medguard_armed_alarms.xml"
PENDING_PREFS="/data/data/$APP_ID/shared_prefs/medguard_pending_actions.xml"

echo "== adb root (required — NotificationActionReceiver is exported=false) =="
adb root
adb wait-for-device

echo "== Arming a real AlarmManager alarm via Diagnostics =="
maestro test .maestro/alarm-notification-action.yaml

echo "== Reading back the occurrenceKey the app actually armed =="
# ArmedAlarmStore (Kotlin) keys its SharedPreferences map BY occurrenceKey, so the <string
# name="..."> attribute IS the key — no app-side logging or code change needed to observe it.
# `adb root` above means this shell reads the app's private storage directly — `run-as` would be
# the alternative, but only works on a debuggable build, and assembleRelease's output is not one.
occurrence_key=$(adb shell cat "$ARMED_PREFS" |
  grep -o 'name="[^"]*"' | head -n1 | sed -E 's/name="(.*)"/\1/')
if [ -z "$occurrence_key" ]; then
  echo "FAIL: could not read an armed occurrenceKey from $ARMED_PREFS." >&2
  exit 1
fi
echo "Armed occurrenceKey: $occurrence_key"

echo "== Force-stopping the app (no live JS runtime for the broadcast to find) =="
adb shell am force-stop "$APP_ID"

echo "== Broadcasting the Taken action directly at NotificationActionReceiver =="
adb shell am broadcast -a com.medguard.alarms.action.TAKEN -n "$RECEIVER" \
  --es com.medguard.alarms.extra.OCCURRENCE_KEY "$occurrence_key"

# The receiver's PendingActionStore.add() call is synchronous (commit(), not apply() — see the
# class doc comment), so this should already be true, but give the filesystem a beat.
sleep 1
echo "== Checking the tap was captured durably before anything else ran =="
pending_after_broadcast=$(adb shell "cat $PENDING_PREFS 2>/dev/null" || true)
if ! echo "$pending_after_broadcast" | grep -q "$occurrence_key"; then
  echo "FAIL: PendingActionStore does not contain the tapped occurrenceKey right after the broadcast." >&2
  exit 1
fi
echo "PASS: the tap is durable on disk with the app process dead."

echo "== Waiting for MedGuardHeadlessService to drain it =="
sleep 8

echo "== Checking the pending-action queue drained =="
pending_after_drain=$(adb shell "cat $PENDING_PREFS 2>/dev/null" || true)
if echo "$pending_after_drain" | grep -q "$occurrence_key"; then
  echo "FAIL: the tap is still pending after the headless drain window — see logcat for headless task errors." >&2
  exit 1
fi
echo "PASS: the headless drain acked the tap — PendingActionStore no longer holds it."

echo "== Relaunching to confirm the app comes back up cleanly =="
maestro test .maestro/subflows/relaunch-sanity.yaml
