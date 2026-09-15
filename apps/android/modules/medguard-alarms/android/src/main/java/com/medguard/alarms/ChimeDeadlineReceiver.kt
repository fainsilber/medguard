package com.medguard.alarms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Fired by `AlarmManager` at `ChimeSession`'s current deadline — the *only* way a Shabbat chime
 * ever stops itself. Unlike a weekday alert, which `NotificationActionReceiver` silences directly
 * the instant Taken or Snooze is tapped, the Shabbat channel posts no such buttons (D5), so this
 * deadline is the one remaining path.
 *
 * Scheduled via the same `AlarmManager` exact-alarm mechanism `AlarmScheduler` already trusts to
 * fire the chime in the first place, rather than an in-process `Handler` timer, which has no
 * guarantee of running to schedule through however long the device sits idle with nothing else to
 * wake it — see `DoseAlarmService.rescheduleStop`.
 *
 * `startService`, not `startForegroundService`: `DoseAlarmService` is already the foreground
 * service holding this alert's notification up, so this only ever delivers a further
 * `onStartCommand` to an already-promoted instance. Delivery of an exact alarm is itself an
 * explicit exemption to the background-start restriction, the same reasoning `AlarmReceiver` and
 * `NotificationActionReceiver`'s own stop call rely on.
 */
class ChimeDeadlineReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        runCatching {
            context.startService(
                Intent(context, DoseAlarmService::class.java).apply {
                    action = DoseAlarmService.ACTION_CHECK_DEADLINE
                },
            )
        }
    }
}
