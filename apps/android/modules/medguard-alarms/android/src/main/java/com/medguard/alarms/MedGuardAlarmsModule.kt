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

    companion object {
        /**
         * Set while a JS runtime exists, so `NotificationActionReceiver` — which runs whether or
         * not the app is alive — can hand a tap straight to JS when it happens to be. When this
         * is null the tap is still durably captured in `PendingActionStore`; it simply waits for
         * the next app launch instead of being applied within seconds.
         */
        @Volatile
        private var instance: MedGuardAlarmsModule? = null

        /**
         * Whether JavaScript is currently running at all.
         *
         * `NotificationActionReceiver` uses this to decide between handing a tap straight over
         * and starting a headless runtime for it (Sprint A4). The tap is durable on disk before
         * either happens, so a wrong answer here costs latency, never a dose.
         */
        fun hasLiveRuntime(): Boolean = instance != null

        fun emitPendingAction(occurrenceKey: String, action: String, tappedAtMs: Long) {
            val module = instance ?: return
            runCatching {
                module.sendEvent(
                    "onPendingAction",
                    mapOf(
                        "occurrenceKey" to occurrenceKey,
                        "action" to action,
                        "tappedAtMs" to tappedAtMs,
                    ),
                )
            }
        }

        /**
         * A rotated FCM token, handed to JS so it can re-register with the server immediately.
         *
         * Best-effort by design: `onNewToken` frequently fires with no runtime alive, which is
         * exactly why `PushTokenStore` writes it down as well. `getPushToken()` below is what
         * the app reads on its next start.
         */
        fun emitPushToken(token: String) {
            val module = instance ?: return
            runCatching { module.sendEvent("onPushToken", mapOf("token" to token)) }
        }
    }

    private fun payloadOf(input: ScheduleDoseAlarmRecord) =
        AlarmPayload(
            occurrenceKey = input.occurrenceKey,
            channelId = input.channelId,
            title = input.title,
            body = input.body,
            chimeDurationSeconds = input.chimeDurationSeconds,
            escalation = input.escalation,
            triggerAtMs = input.triggerAtMs,
        )

    override fun definition() =
        ModuleDefinition {
            Name("MedGuardAlarms")

            Events("onPendingAction", "onPushToken")

            OnCreate {
                MedGuardChannels.createAll(context)
                instance = this@MedGuardAlarmsModule
            }

            OnDestroy {
                instance = null
            }

            AsyncFunction("scheduleDoseAlarm") { input: ScheduleDoseAlarmRecord ->
                AlarmScheduler.schedule(context, payloadOf(input))
            }

            // The batch form the alarm engine's reconcile pass uses: a 48-hour horizon can be
            // dozens of occurrences, and one bridge call beats one per alarm.
            AsyncFunction("armDoseAlarms") { inputs: List<ScheduleDoseAlarmRecord> ->
                for (input in inputs) {
                    AlarmScheduler.schedule(context, payloadOf(input))
                }
            }

            AsyncFunction("cancelDoseAlarm") { occurrenceKey: String ->
                AlarmScheduler.cancel(context, occurrenceKey)
            }

            AsyncFunction("cancelAllDoseAlarms") {
                AlarmScheduler.cancelAll(context)
            }

            /**
             * What is armed right now, straight from the store `BootReceiver` re-arms from.
             *
             * JS reconciles against this rather than against a list of its own, because Kotlin's
             * is the one that reflects reality: `BootReceiver` re-arms after a reboot and drops
             * alarms whose time passed while the phone was off, and JS never sees either event. A
             * parallel JS-side table would drift from the truth on exactly the reboot path that
             * "alarms silently stop firing" is the worst failure mode of.
             */
            AsyncFunction("listArmedAlarms") {
                ArmedAlarmStore.getAll(context).map { payload ->
                    mapOf(
                        "occurrenceKey" to payload.occurrenceKey,
                        "triggerAtMs" to payload.triggerAtMs,
                        // Sprint A5: the channel is part of what "already armed correctly" means.
                        // A dose whose time has not moved but whose channel has — Shabbat starting
                        // or ending between reconciles — must be re-armed, or it rings with
                        // action buttons on Shabbat.
                        "channelId" to payload.channelId,
                    )
                }
            }

            AsyncFunction("showStatusNotification") { title: String, body: String ->
                StatusNotifier.show(context, title, body)
            }

            AsyncFunction("clearStatusNotification") {
                StatusNotifier.clear(context)
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

            // Read and ack are separate on purpose (AD2, safety invariant 7): a destructive drain
            // loses the caregiver's tap outright if the process dies between reading it and
            // writing the resulting IntakeLog — and the drain runs at app startup, which is
            // exactly when Android is most willing to kill things. JS acks only after the dose has
            // committed, so a crash costs a repeated read rather than a lost dose.
            AsyncFunction("readPendingActions") {
                PendingActionStore.readAll(context).map { entry ->
                    mapOf(
                        "id" to entry.id,
                        "occurrenceKey" to entry.occurrenceKey,
                        "action" to entry.action,
                        "tappedAtMs" to entry.tappedAtMs,
                    )
                }
            }

            AsyncFunction("ackPendingActions") { ids: List<String> ->
                PendingActionStore.ack(context, ids)
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

            /**
             * The FCM registration token, or null when this build has no Firebase project wired
             * up (no `google-services.json`) or Firebase has not issued one yet.
             *
             * Null is a supported state, not an error: local alarms are primary, and a device
             * without a token simply has no server backstop — which `alarmHealth` reports rather
             * than hiding (safety invariant 6).
             */
            AsyncFunction("getPushToken") {
                PushTokenStore.read(context)
            }
        }
}
