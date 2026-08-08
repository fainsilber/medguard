package com.medguard.alarms

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The thin TS <-> Kotlin surface (docs/android-client-plan.md, "The native alarm layer"). Every
 * function here is a direct pass-through to `AlarmScheduler`, `DoseAlarmService`,
 * `PendingActionStore` or a platform permission check — no domain logic lives in this file.
 */
class MedGuardAlarmsModule : Module() {
    private val context: Context
        get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

    override fun definition() =
        ModuleDefinition {
            Name("MedGuardAlarms")

            OnCreate {
                MedGuardChannels.createAll(context)
            }

            AsyncFunction("scheduleDoseAlarm") { input: ScheduleDoseAlarmRecord ->
                AlarmScheduler.schedule(
                    context,
                    AlarmPayload(
                        occurrenceKey = input.occurrenceKey,
                        channelId = input.channelId,
                        title = input.title,
                        body = input.body,
                        chimeDurationSeconds = input.chimeDurationSeconds,
                        escalation = input.escalation,
                        triggerAtMs = input.triggerAtMs,
                    ),
                )
            }

            AsyncFunction("cancelDoseAlarm") { occurrenceKey: String ->
                AlarmScheduler.cancel(context, occurrenceKey)
            }

            // The A0 exit-gate demo (docs/android-client-plan.md, manual QA item 1): fires the
            // real chime immediately through the same DoseAlarmService a scheduled alarm uses,
            // with no AlarmManager round-trip needed to prove the sound and auto-stop work.
            AsyncFunction("playTestChime") { chimeDurationSeconds: Int ->
                val intent =
                    Intent(context, DoseAlarmService::class.java).apply {
                        putExtra(
                            AlarmScheduler.EXTRA_PAYLOAD,
                            AlarmPayload(
                                occurrenceKey = "test-chime",
                                channelId = MedGuardChannels.DOSE_STANDARD,
                                title = "MedGuard test chime",
                                body = "This is what a dose alarm sounds like.",
                                chimeDurationSeconds = chimeDurationSeconds,
                                escalation = false,
                                triggerAtMs = System.currentTimeMillis(),
                            ).toJson().toString(),
                        )
                    }
                androidx.core.content.ContextCompat.startForegroundService(context, intent)
            }

            AsyncFunction("canScheduleExactAlarms") {
                AlarmScheduler.canScheduleExactAlarms(context)
            }

            AsyncFunction("requestScheduleExactAlarm") {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    context.startActivity(
                        Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                            data = Uri.parse("package:${context.packageName}")
                            flags = Intent.FLAG_ACTIVITY_NEW_TASK
                        },
                    )
                }
            }

            AsyncFunction("canUseFullScreenIntent") {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                    val manager = context.getSystemService(NotificationManager::class.java)
                    manager?.canUseFullScreenIntent() ?: false
                } else {
                    true
                }
            }

            AsyncFunction("isIgnoringBatteryOptimizations") {
                val manager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
                manager.isIgnoringBatteryOptimizations(context.packageName)
            }

            AsyncFunction("requestIgnoreBatteryOptimizations") {
                context.startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                        data = Uri.parse("package:${context.packageName}")
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    },
                )
            }

            // POST_NOTIFICATIONS (Android 13+): declared in the manifest via the config plugin,
            // but declaring it never prompts the OS dialog on its own — a runtime request is
            // required, same as SCHEDULE_EXACT_ALARM below. Without this, the chime's
            // foreground-service notification (and the Taken/Snooze actions) never becomes
            // visible on a first install, even though the alarm-stream audio itself isn't gated
            // by it.
            AsyncFunction("hasNotificationPermission") {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
                        PackageManager.PERMISSION_GRANTED
                } else {
                    true
                }
            }

            AsyncFunction("requestNotificationPermission") { promise: Promise ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    Permissions.askForPermissionsWithPermissionsManager(
                        appContext.permissions,
                        promise,
                        Manifest.permission.POST_NOTIFICATIONS,
                    )
                } else {
                    promise.resolve(mapOf("granted" to true))
                }
            }

            AsyncFunction("hasNotificationPolicyAccess") {
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                manager.isNotificationPolicyAccessGranted
            }

            AsyncFunction("requestNotificationPolicyAccess") {
                context.startActivity(
                    Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    },
                )
            }

            AsyncFunction("drainPendingActions") {
                PendingActionStore.drainAll(context).map { entry ->
                    mapOf(
                        "occurrenceKey" to entry.occurrenceKey,
                        "action" to entry.action,
                        "tappedAtMs" to entry.tappedAtMs,
                    )
                }
            }

            // `src/clock/localClockGuard.ts`'s tamper-detection reference: milliseconds since
            // boot, *including* time spent in deep sleep — unlike React Native's own
            // `performance.now()` (`CLOCK_MONOTONIC` on Android, which halts across real device
            // sleep), so a normal phone-locked period no longer looks identical to a caregiver
            // winding the wall clock forward. Still immune to that tampering itself: this reads a
            // kernel timer, not the user-settable system clock `Date.now()` reads.
            AsyncFunction("elapsedRealtimeMs") {
                SystemClock.elapsedRealtime()
            }
        }
}
