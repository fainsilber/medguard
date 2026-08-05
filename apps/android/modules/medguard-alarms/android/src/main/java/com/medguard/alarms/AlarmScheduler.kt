package com.medguard.alarms

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build

/**
 * `AlarmManager.setAlarmClock()`, not `setExactAndAllowWhileIdle` — the highest-priority alarm
 * class Android offers: exempt from Doze and App Standby buckets, never batched with other
 * apps' alarms, and respected far more consistently by OEM battery managers
 * (docs/android-client-plan.md, "Scheduling"). The cost is a visible upcoming-alarm affordance
 * in the system UI, which for a medication app is arguably a feature.
 */
object AlarmScheduler {
    private const val ACTION_FIRE_DOSE_ALARM = "com.medguard.alarms.action.FIRE_DOSE_ALARM"
    const val EXTRA_PAYLOAD = "com.medguard.alarms.extra.PAYLOAD"

    private fun alarmManager(context: Context) = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    /**
     * Each occurrence gets a distinct `PendingIntent`: `occurrenceKey` becomes the Uri, which
     * (together with the request code) is what `PendingIntent` treats as identity, so scheduling
     * one occurrence never clobbers another's pending intent, and re-scheduling the same
     * occurrence (e.g. after a schedule edit) correctly replaces it via `FLAG_UPDATE_CURRENT`.
     */
    private fun firePendingIntent(context: Context, payload: AlarmPayload): PendingIntent {
        val intent =
            Intent(context, AlarmReceiver::class.java).apply {
                action = ACTION_FIRE_DOSE_ALARM
                data = Uri.parse("medguard-alarm://${payload.occurrenceKey}")
                putExtra(EXTRA_PAYLOAD, payload.toJson().toString())
            }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getBroadcast(context, payload.occurrenceKey.hashCode(), intent, flags)
    }

    private fun showPendingIntent(context: Context, occurrenceKey: String): PendingIntent {
        val launchIntent =
            context.packageManager.getLaunchIntentForPackage(context.packageName)
                ?: Intent(Intent.ACTION_MAIN)
        launchIntent.data = Uri.parse("medguard-alarm://${occurrenceKey}")
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        return PendingIntent.getActivity(context, occurrenceKey.hashCode(), launchIntent, flags)
    }

    fun schedule(context: Context, payload: AlarmPayload) {
        val info = AlarmManager.AlarmClockInfo(payload.triggerAtMs, showPendingIntent(context, payload.occurrenceKey))
        alarmManager(context).setAlarmClock(info, firePendingIntent(context, payload))
        ArmedAlarmStore.put(context, payload)
    }

    fun cancel(context: Context, occurrenceKey: String) {
        val intent =
            Intent(context, AlarmReceiver::class.java).apply {
                action = ACTION_FIRE_DOSE_ALARM
                data = Uri.parse("medguard-alarm://${occurrenceKey}")
            }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pendingIntent = PendingIntent.getBroadcast(context, occurrenceKey.hashCode(), intent, flags)
        alarmManager(context).cancel(pendingIntent)
        ArmedAlarmStore.remove(context, occurrenceKey)
    }

    /**
     * `false` is not a silent failure — it is checked on every arm and drives the "alarms
     * unarmed" degradation state (AD7, safety invariant 6).
     */
    fun canScheduleExactAlarms(context: Context): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            alarmManager(context).canScheduleExactAlarms()
        } else {
            true
        }
}
