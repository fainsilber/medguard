package com.medguard.alarms

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build

/**
 * Channels, created once with versioned ids (docs/android-client-plan.md, "Channels" table). A
 * channel's sound and importance are immutable after creation — without versioned ids, retuning
 * the chime the way the web Shabbat burst was retuned four times would require every caregiver
 * to reinstall the app.
 */
object MedGuardChannels {
    const val DOSE_STANDARD = "dose_standard_v1"
    const val DOSE_ESCALATION = "dose_escalation_v1"
    const val SHABBAT = "shabbat_v1"
    const val LOW_STOCK = "low_stock_v1"
    const val SYNC_STATUS = "sync_status_v1"

    fun createAll(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val alarmAttributes =
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        val defaultSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val defaultAlarmSound = RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_ALARM)

        manager.createNotificationChannel(
            NotificationChannel(DOSE_STANDARD, "Dose reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A medicine is due now."
                setSound(defaultSound, alarmAttributes)
            },
        )

        manager.createNotificationChannel(
            NotificationChannel(DOSE_ESCALATION, "Missed-dose escalation", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A dose has gone unacknowledged."
                setSound(defaultSound, alarmAttributes)
                // Effective only once the user has granted ACCESS_NOTIFICATION_POLICY (AD7); a
                // missing grant means the OS silently ignores this rather than failing loudly.
                setBypassDnd(true)
            },
        )

        manager.createNotificationChannel(
            // AD3: no action buttons on native (D5) — the shabbat channel exposes none in the
            // notification itself; DoseAlarmService is what plays the real 45s chime.
            NotificationChannel(SHABBAT, "Shabbat alerts", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Shabbat-mode dose alert. No actions — reconciliation happens after Havdalah."
                setSound(defaultAlarmSound, alarmAttributes)
            },
        )

        manager.createNotificationChannel(
            NotificationChannel(LOW_STOCK, "Low stock", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "A medicine is running low."
            },
        )

        manager.createNotificationChannel(
            NotificationChannel(SYNC_STATUS, "Sync status", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Whether alarms are armed and sync is current."
                setSound(null, null)
                setShowBadge(false)
            },
        )
    }
}
