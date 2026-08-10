package com.medguard.alarms

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * How a dose alert looks, in one place.
 *
 * Two things post one now: the local alarm's `DoseAlarmService` (Sprint A3) and the server's
 * push, arriving through `MedGuardMessagingService` (Sprint A4). They must look identical and
 * behave identically — same actions, same Shabbat rule, same escalation treatment — because from
 * a caregiver's side they *are* the same alert, and which mechanism delivered it is an
 * implementation detail they should never be able to notice.
 *
 * The notification id is derived from the `occurrenceKey`, which is what makes a late server push
 * *replace* the notification the device already showed for that dose rather than stack a second
 * one beside it (docs/android-client-plan.md, "Local versus server alarms").
 */
object DoseNotifications {
    fun notificationId(occurrenceKey: String): Int = occurrenceKey.hashCode()

    fun build(context: Context, payload: AlarmPayload, ongoing: Boolean = true): Notification {
        val builder =
            NotificationCompat.Builder(context, payload.channelId)
                .setContentTitle(payload.title)
                .setContentText(payload.body)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setOngoing(ongoing)
                .setOnlyAlertOnce(true)

        // Taken/Snooze belong to a dose and nothing else. The Shabbat channel is excluded because
        // tapping an action writes a record, which is the whole thing Shabbat mode exists to
        // avoid (D5 / AD3); low stock is excluded because there is no dose to take — it is about
        // a medicine running out. This mirrors the channel table in docs/android-client-plan.md.
        val carriesDoseActions =
            payload.channelId == MedGuardChannels.DOSE_STANDARD ||
                payload.channelId == MedGuardChannels.DOSE_ESCALATION
        if (carriesDoseActions) {
            builder.addAction(
                0,
                "Taken",
                actionPendingIntent(context, payload, NotificationActionReceiver.ACTION_TAKEN),
            )
            builder.addAction(
                0,
                "Snooze",
                actionPendingIntent(context, payload, NotificationActionReceiver.ACTION_SNOOZE),
            )
        }

        // AD4: full-screen intent is reserved for escalation, and only attempted when the OS
        // says this app is currently permitted to use it — otherwise this degrades to an
        // ordinary heads-up notification, which `NotificationCompat` already gives us for free.
        if (payload.escalation && canUseFullScreenIntent(context)) {
            val launchIntent =
                context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
            if (launchIntent != null) {
                val fullScreenPendingIntent =
                    PendingIntent.getActivity(
                        context,
                        notificationId(payload.occurrenceKey),
                        launchIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    )
                builder.setFullScreenIntent(fullScreenPendingIntent, true)
            }
        }

        return builder.build()
    }

    fun canUseFullScreenIntent(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
        val manager = context.getSystemService(NotificationManager::class.java)
        return manager?.canUseFullScreenIntent() ?: false
    }

    private fun actionPendingIntent(
        context: Context,
        payload: AlarmPayload,
        action: String,
    ): PendingIntent {
        val intent =
            Intent(context, NotificationActionReceiver::class.java).apply {
                this.action = action
                putExtra(NotificationActionReceiver.EXTRA_OCCURRENCE_KEY, payload.occurrenceKey)
                putExtra(
                    NotificationActionReceiver.EXTRA_NOTIFICATION_ID,
                    notificationId(payload.occurrenceKey),
                )
            }
        val requestCode = (payload.occurrenceKey + action).hashCode()
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
