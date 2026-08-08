package com.medguard.alarms

import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/**
 * The heart of the native client. `foregroundServiceType="mediaPlayback"` — deliberately not
 * `dataSync` or `mediaProcessing`, the two types Android 15 caps at six hours per 24-hour period
 * (docs/android-client-plan.md, "The chime").
 *
 * `MediaPlayer` on `AudioAttributes.USAGE_ALARM` + `CONTENT_TYPE_SONIFICATION` is what makes the
 * chime sound through ring-silent. It plays for exactly `chimeDurationSeconds` (PRD default 45)
 * and `stopSelf()`s at the end. No wake lock, no screen wake, no touch — PRD §3 is explicit that
 * the screen stays in whatever state it was already in and nothing is triggered by this alarm
 * except sound.
 */
class DoseAlarmService : Service() {
    private var mediaPlayer: MediaPlayer? = null
    private val stopHandler = Handler(Looper.getMainLooper())
    private var stopRunnable: Runnable? = null
    private var currentPayload: AlarmPayload? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val raw = intent?.getStringExtra(AlarmScheduler.EXTRA_PAYLOAD)
        val payload = raw?.let { runCatching { AlarmPayload.fromJson(JSONObject(it)) }.getOrNull() }

        if (payload == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        currentPayload = payload
        startForeground(notificationId(payload.occurrenceKey), buildNotification(payload))
        startChime(payload.chimeDurationSeconds)

        return START_NOT_STICKY
    }

    private fun startChime(durationSeconds: Int) {
        val attributes =
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        val alarmSound = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM)

        mediaPlayer =
            MediaPlayer().apply {
                setAudioAttributes(attributes)
                setDataSource(this@DoseAlarmService, alarmSound)
                isLooping = true
                prepare()
                start()
            }

        val runnable = Runnable { stopChimeAndSelf() }
        stopRunnable = runnable
        stopHandler.postDelayed(runnable, durationSeconds * 1000L)
    }

    private fun stopChimeAndSelf() {
        mediaPlayer?.let {
            runCatching { it.stop() }
            it.release()
        }
        mediaPlayer = null

        // The chime auto-stopping must not also delete the caregiver's chance to respond: a
        // caregiver who doesn't reach the phone within the chime's window still needs Taken/Snooze
        // available afterward (durably captured via `NotificationActionReceiver` even with the app
        // dead — AD2). `STOP_FOREGROUND_REMOVE` would delete the notification outright the instant
        // the chime ends; re-posting it first as a plain (non-`ongoing`) notification, then
        // detaching rather than removing, keeps it visible and dismissible with its actions intact.
        currentPayload?.let { payload ->
            val manager = getSystemService(NotificationManager::class.java)
            manager?.notify(notificationId(payload.occurrenceKey), buildNotification(payload, ongoing = false))
        }
        stopForeground(STOP_FOREGROUND_DETACH)
        stopSelf()
    }

    override fun onDestroy() {
        stopRunnable?.let { stopHandler.removeCallbacks(it) }
        mediaPlayer?.release()
        mediaPlayer = null
        super.onDestroy()
    }

    private fun notificationId(occurrenceKey: String): Int = occurrenceKey.hashCode()

    private fun buildNotification(payload: AlarmPayload, ongoing: Boolean = true): android.app.Notification {
        val builder =
            NotificationCompat.Builder(this, payload.channelId)
                .setContentTitle(payload.title)
                .setContentText(payload.body)
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setOngoing(ongoing)
                .setOnlyAlertOnce(true)

        // D5 / AD3: the Shabbat channel carries no actions at all.
        if (payload.channelId != MedGuardChannels.SHABBAT) {
            builder.addAction(0, "Taken", actionPendingIntent(payload, NotificationActionReceiver.ACTION_TAKEN))
            builder.addAction(0, "Snooze", actionPendingIntent(payload, NotificationActionReceiver.ACTION_SNOOZE))
        }

        // AD4: full-screen intent is reserved for escalation, and only attempted when the OS
        // says this app is currently permitted to use it — otherwise this degrades to an
        // ordinary heads-up notification, which `NotificationCompat` already gives us for free.
        if (payload.escalation && canUseFullScreenIntent()) {
            val launchIntent =
                packageManager.getLaunchIntentForPackage(packageName)?.apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
            if (launchIntent != null) {
                val fullScreenPendingIntent =
                    PendingIntent.getActivity(
                        this,
                        notificationId(payload.occurrenceKey),
                        launchIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                    )
                builder.setFullScreenIntent(fullScreenPendingIntent, true)
            }
        }

        return builder.build()
    }

    private fun canUseFullScreenIntent(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return true
        val manager = getSystemService(NotificationManager::class.java)
        return manager?.canUseFullScreenIntent() ?: false
    }

    private fun actionPendingIntent(payload: AlarmPayload, action: String): PendingIntent {
        val intent =
            Intent(this, NotificationActionReceiver::class.java).apply {
                this.action = action
                putExtra(NotificationActionReceiver.EXTRA_OCCURRENCE_KEY, payload.occurrenceKey)
                putExtra(NotificationActionReceiver.EXTRA_NOTIFICATION_ID, notificationId(payload.occurrenceKey))
            }
        val requestCode = (payload.occurrenceKey + action).hashCode()
        return PendingIntent.getBroadcast(
            this,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
