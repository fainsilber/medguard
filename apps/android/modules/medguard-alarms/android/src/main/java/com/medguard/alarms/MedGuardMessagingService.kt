package com.medguard.alarms

import android.app.NotificationManager
import android.content.Context
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * The server's push, arriving on the device (Sprint A4).
 *
 * **This is the backstop, not the primary alarm.** The local `AlarmManager` alarm is what plays
 * the PRD's 45-second chime and what works with no signal at all. This exists for the cases the
 * phone structurally cannot cover on its own:
 *
 *   - **Escalation.** A device cannot know whether *another* caregiver acknowledged a dose. Only
 *     the household's Durable Object can, so escalation is server-only by construction.
 *   - **An unarmed device.** Exact-alarm permission denied, notifications restricted, an OEM
 *     battery manager, the phone off when the alarm was due. Nothing local fires; this still
 *     arrives.
 *
 * Messages are **data-only** by design (`apps/api/src/push/fcm.ts`). With a `notification` block
 * Android would compose and post the notification itself while the app is backgrounded, which
 * means the wrong channel, no Taken/Snooze actions, and — on Shabbat — action buttons this app
 * must never show (delta D5). Composing it here is what keeps that under our control.
 *
 * **No chime is started from a push.** `DoseAlarmService` owns the 45 seconds of alarm-stream
 * audio, and it is driven by the local alarm. A device reaching this path with no local alarm
 * armed gets its channel's sound rather than the full chime — the honest degradation, since the
 * reason it is unarmed is that the OS or the caregiver has restricted this app.
 */
class MedGuardMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        PushTokenStore.save(applicationContext, token)
        MedGuardAlarmsModule.emitPushToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val kind = data["kind"] ?: return
        val title = data["title"] ?: return
        val body = data["body"] ?: return
        val channelId = data["channelId"] ?: MedGuardChannels.DOSE_STANDARD

        // Channels are normally created when the JS module loads; a push can arrive with the app
        // never having been opened since an update added one.
        MedGuardChannels.createAll(applicationContext)

        // Low-stock alerts have no occurrence — they are about a medicine, not a dose — so they
        // key off the medicine instead. Everything else is identified by its `occurrenceKey`,
        // which is exactly what makes this replace a notification the local alarm already posted
        // for the same dose rather than stacking a second one beside it.
        val key = data["occurrenceId"] ?: "medicine:${data["medicineId"] ?: kind}"

        val payload =
            AlarmPayload(
                occurrenceKey = key,
                channelId = channelId,
                title = title,
                body = body,
                // Unused on this path: nothing here starts the chime service. Carried only
                // because `AlarmPayload` is the shape `DoseNotifications` speaks.
                chimeDurationSeconds = 0,
                escalation = kind == "escalation",
                triggerAtMs = System.currentTimeMillis(),
            )

        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(
            DoseNotifications.notificationId(key),
            // `ongoing = false`: this notification belongs to no foreground service, and a
            // caregiver must always be able to dismiss it.
            DoseNotifications.build(applicationContext, payload, ongoing = false),
        )
    }
}
