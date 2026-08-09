package com.medguard.alarms

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

/**
 * The ongoing, silent notification on `sync_status_v1` that carries the two degradation states
 * A3 owes safety invariant 6: *alarms are not armed* and *sync is stale*.
 *
 * It lives in the notification shade rather than only in the app because both states are, by
 * definition, states a caregiver is not currently looking at the app to discover. A phone whose
 * exact-alarm permission was revoked by a battery manager looks completely normal until a dose is
 * silently missed; this is the thing that makes it look wrong instead.
 *
 * Deliberately `IMPORTANCE_LOW`, silent, badge-less and `ongoing` — it must be impossible to
 * confuse with a dose alarm, and impossible to swipe away while the condition it reports is still
 * true. Composed here rather than in JS for the same reason the dose notification is: JS may not
 * be running when it needs to change.
 */
object StatusNotifier {
    /** Fixed: there is only ever one status notification, and a new one replaces the old. */
    private const val NOTIFICATION_ID = 424242

    private fun manager(context: Context) =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    fun show(context: Context, title: String, body: String) {
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val contentIntent =
            launchIntent?.let {
                PendingIntent.getActivity(
                    context,
                    NOTIFICATION_ID,
                    it.apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP },
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            }

        val notification =
            NotificationCompat.Builder(context, MedGuardChannels.SYNC_STATUS)
                .setContentTitle(title)
                .setContentText(body)
                // The text is a sentence or two of explanation, not a label — without this it is
                // truncated to one line and the caregiver sees a warning with no reason attached.
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setOngoing(true)
                .setSilent(true)
                .setShowWhen(false)
                .apply { contentIntent?.let { setContentIntent(it) } }
                .build()

        manager(context).notify(NOTIFICATION_ID, notification)
    }

    fun clear(context: Context) {
        manager(context).cancel(NOTIFICATION_ID)
    }
}
