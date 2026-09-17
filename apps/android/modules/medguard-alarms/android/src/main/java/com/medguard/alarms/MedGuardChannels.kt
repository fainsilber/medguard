package com.medguard.alarms

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build

/**
 * Channels, created once with versioned ids (docs/android-client-plan.md, "Channels" table). A
 * channel's sound and importance are immutable after creation — without versioned ids, retuning
 * the chime the way the web Shabbat burst was retuned four times would require every caregiver
 * to reinstall the app.
 *
 * **v2 (this version): no channel sound on the three dose-alert channels.** v1 gave each of them
 * a `setSound(...)` with alarm audio attributes — the same alarm ringtone `DoseAlarmService`
 * separately plays through its own `MediaPlayer`. That meant every alert had two independent
 * sound sources: our `MediaPlayer`, fully controlled by `ChimeSession`/`ChimeDeadlineReceiver`, and
 * the OS's own channel-sound playback triggered the instant the notification posts — which none
 * of `stopEverything()`/`ACTION_STOP_CHIME`/the deadline alarm has any way to reach, because it
 * was never ours to stop. On a Shabbat alert (a long `USAGE_ALARM`-attributed ringtone, repeated
 * by some Android versions) this is exactly what let a chime keep sounding well after this
 * service's own logs showed a clean stop. `MediaPlayer` was always meant to be the sole audio
 * source (see `DoseAlarmService`'s class doc); channel sound is now `null` throughout, and the
 * ids are bumped so already-installed devices actually pick up the change.
 */
object MedGuardChannels {
    const val DOSE_STANDARD = "dose_standard_v2"
    const val DOSE_ESCALATION = "dose_escalation_v2"
    const val SHABBAT = "shabbat_v2"
    const val LOW_STOCK = "low_stock_v1"
    const val SYNC_STATUS = "sync_status_v1"

    fun createAll(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        manager.createNotificationChannel(
            NotificationChannel(DOSE_STANDARD, "Dose reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A medicine is due now."
                setSound(null, null)
            },
        )

        manager.createNotificationChannel(
            NotificationChannel(DOSE_ESCALATION, "Missed-dose escalation", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A dose has gone unacknowledged."
                setSound(null, null)
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
                setSound(null, null)
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
