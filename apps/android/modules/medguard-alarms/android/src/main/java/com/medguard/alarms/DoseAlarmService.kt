package com.medguard.alarms

import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.support.v4.media.session.MediaSessionCompat
import androidx.media.VolumeProviderCompat
import org.json.JSONObject

/**
 * The heart of the native client. `foregroundServiceType="mediaPlayback"` — deliberately not
 * `dataSync` or `mediaProcessing`, the two types Android 15 caps at six hours per 24-hour period
 * (docs/android-client-plan.md, "The chime").
 *
 * `MediaPlayer` on `AudioAttributes.USAGE_ALARM` + `CONTENT_TYPE_SONIFICATION` is what makes the
 * chime sound through ring-silent. No wake lock, no screen wake, no touch — PRD §3 is explicit
 * that the screen stays in whatever state it was already in and nothing is triggered by this alarm
 * except sound.
 *
 * **This service may be handling several doses at once, and that is the case it exists to get
 * right.** A household gives several medicines at 08:00, so two alarms fire into the same service
 * instance and `onStartCommand` runs twice. It used to keep one `MediaPlayer` in a bare field and
 * reassign it, orphaning a player that was still looping and that nothing could stop — the bug
 * behind a Shabbat of continuous alerts. All of that state now lives in [ChimeSession], which is
 * pure and unit-tested; this file owns only the Android side of acting on its decisions:
 *
 *  - **one shared player** for however many doses are sounding, so simultaneous alerts are one
 *    sound and several notifications, not several overlapping sounds;
 *  - **one stop callback**, re-posted to the session's latest deadline after every change;
 *  - **stop conditions beyond the timeout**: a physical button or screen event (below), and an
 *    explicit [ACTION_STOP_CHIME] sent when a caregiver marks the dose.
 */
class DoseAlarmService : Service() {
    companion object {
        /**
         * Silence the chime. Sent by `NotificationActionReceiver` when a lock-screen action is
         * tapped, and by JS through `MedGuardAlarmsModule.stopChime` when a dose is marked in the
         * app — marking a dose that is audibly ringing must stop the ringing, which it previously
         * did not.
         *
         * With [EXTRA_OCCURRENCE_KEY] only that dose is dropped (and the sound stops only if it
         * was the last one); without it the sound stops outright. The caregiver pressed something,
         * so the alert has done its job — but every notification survives, non-`ongoing` and
         * dismissible, because an un-acted-on dose still needs its Taken/Snooze buttons.
         */
        const val ACTION_STOP_CHIME = "com.medguard.alarms.action.STOP_CHIME"
        const val EXTRA_OCCURRENCE_KEY = "com.medguard.alarms.extra.OCCURRENCE_KEY"

        /** Only the alarm stream matters here; the value is arbitrary and never displayed. */
        private const val VOLUME_CONTROL_MAX = 10
    }

    private val session = ChimeSession()
    private val stopHandler = Handler(Looper.getMainLooper())
    private var stopRunnable: Runnable? = null

    private var mediaPlayer: MediaPlayer? = null
    private val payloads = mutableMapOf<String, AlarmPayload>()

    /** Registered only while something is sounding — these actions cannot come from the manifest. */
    private var screenReceiver: BroadcastReceiver? = null
    private var mediaSession: MediaSessionCompat? = null

    /** Which occurrence's notification is currently holding the foreground service up. */
    private var foregroundKey: String? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP_CHIME) {
            val key = intent.getStringExtra(EXTRA_OCCURRENCE_KEY)
            if (key == null) {
                stopEverything()
            } else {
                dropOne(key)
            }
            return START_NOT_STICKY
        }

        val raw = intent?.getStringExtra(AlarmScheduler.EXTRA_PAYLOAD)
        val payload = raw?.let { runCatching { AlarmPayload.fromJson(JSONObject(it)) }.getOrNull() }

        if (payload == null) {
            // Nothing to ring about. Only stop the service if nothing else is: an unparseable
            // intent must not silence a dose that is legitimately sounding.
            if (session.isIdle()) {
                stopSelf()
            }
            return START_NOT_STICKY
        }

        payloads[payload.occurrenceKey] = payload

        val nowMs = System.currentTimeMillis()
        val mustStartPlayer = session.add(payload.occurrenceKey, nowMs, payload.chimeDurationSeconds)

        // Each dose keeps its own notification, so two simultaneous doses read as two alerts. The
        // first one to arrive is the one `startForeground` is anchored to; the rest are posted
        // normally. `notificationId` is derived from the occurrence key, so a later server push
        // for the same dose still replaces rather than stacks.
        if (foregroundKey == null) {
            foregroundKey = payload.occurrenceKey
            startForeground(notificationId(payload.occurrenceKey), buildNotification(payload))
        } else {
            postNotification(payload, ongoing = true)
        }

        if (mustStartPlayer) {
            startChime()
            startListeningForButtons()
        }
        rescheduleStop()

        return START_NOT_STICKY
    }

    /**
     * The one player, created only on the idle→active transition and never reassigned while
     * non-null. That invariant is the fix: there is no longer any path that leaves a looping
     * player unreachable.
     */
    private fun startChime() {
        if (mediaPlayer != null) {
            return
        }

        val attributes =
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        val alarmSound = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM)

        mediaPlayer =
            runCatching {
                MediaPlayer().apply {
                    setAudioAttributes(attributes)
                    setDataSource(this@DoseAlarmService, alarmSound)
                    isLooping = true
                    prepare()
                    start()
                }
            }.getOrNull()
    }

    private fun releasePlayer() {
        mediaPlayer?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        mediaPlayer = null
    }

    /**
     * Points the single stop callback at the session's latest deadline.
     *
     * Cancel-and-repost rather than one callback per alarm: a stale callback firing for an alarm
     * that has already ended used to cut a later dose's chime short.
     */
    private fun rescheduleStop() {
        stopRunnable?.let { stopHandler.removeCallbacks(it) }
        stopRunnable = null

        val endsAtMs = session.soundEndsAtMs() ?: return
        val runnable = Runnable { onDeadlineReached() }
        stopRunnable = runnable
        stopHandler.postDelayed(runnable, (endsAtMs - System.currentTimeMillis()).coerceAtLeast(0L))
    }

    private fun onDeadlineReached() {
        val nowMs = System.currentTimeMillis()
        for (chime in session.takeExpired(nowMs)) {
            settle(chime.occurrenceKey)
        }

        if (session.isIdle()) {
            stopEverything()
        } else {
            // A dose that began ringing later is still owed the rest of its own length.
            moveForegroundIfNeeded()
            rescheduleStop()
        }
    }

    /** Drops one dose from the session; stops the sound only if it was the last one. */
    private fun dropOne(occurrenceKey: String) {
        if (!session.contains(occurrenceKey)) {
            return
        }
        session.remove(occurrenceKey)
        settle(occurrenceKey)

        if (session.isIdle()) {
            stopEverything()
        } else {
            moveForegroundIfNeeded()
            rescheduleStop()
        }
    }

    private fun stopEverything() {
        val remaining = session.takeAll()
        releasePlayer()
        stopListeningForButtons()
        stopRunnable?.let { stopHandler.removeCallbacks(it) }
        stopRunnable = null

        for (chime in remaining) {
            settle(chime.occurrenceKey)
        }
        payloads.clear()
        foregroundKey = null

        stopForeground(STOP_FOREGROUND_DETACH)
        stopSelf()
    }

    /**
     * The chime ending must not also delete the caregiver's chance to respond: a caregiver who
     * doesn't reach the phone within the chime's window still needs Taken/Snooze available
     * afterward (durably captured via `NotificationActionReceiver` even with the app dead — AD2).
     * `STOP_FOREGROUND_REMOVE` would delete the notification outright the instant the chime ends;
     * re-posting each one as a plain, non-`ongoing` notification first — and then detaching rather
     * than removing — keeps it visible and dismissible with its actions intact.
     */
    private fun settle(occurrenceKey: String) {
        payloads.remove(occurrenceKey)?.let { postNotification(it, ongoing = false) }
    }

    /**
     * When the alarm anchoring the foreground service ends while others are still sounding, the
     * service has to be re-anchored to one of them or Android has no notification to attach it to.
     */
    private fun moveForegroundIfNeeded() {
        val current = foregroundKey
        if (current != null && session.contains(current)) {
            return
        }
        val next = session.foreground() ?: return
        val payload = payloads[next.occurrenceKey] ?: return
        foregroundKey = next.occurrenceKey
        startForeground(notificationId(next.occurrenceKey), buildNotification(payload))
    }

    private fun postNotification(payload: AlarmPayload, ongoing: Boolean) {
        val manager = getSystemService(NotificationManager::class.java)
        manager?.notify(notificationId(payload.occurrenceKey), buildNotification(payload, ongoing))
    }

    /**
     * "A button was pressed, even though no dose was marked."
     *
     * Screen-off and unlock are unambiguously a person; screen-on is honoured only outside
     * `ChimeSession`'s grace window, because a high-importance notification can light the screen
     * itself. Volume keys arrive through a `MediaSessionCompat` with a remote volume provider,
     * which is the only way an app receives them while the sound is on the alarm stream. Both are
     * torn down the moment nothing is sounding, so this service holds nothing while idle.
     */
    private fun startListeningForButtons() {
        if (screenReceiver == null) {
            val receiver =
                object : BroadcastReceiver() {
                    override fun onReceive(context: Context, intent: Intent) {
                        if (session.shouldSilenceOnScreenEvent(intent.action, System.currentTimeMillis())) {
                            stopEverything()
                        }
                    }
                }
            val filter =
                IntentFilter().apply {
                    addAction(Intent.ACTION_SCREEN_ON)
                    addAction(Intent.ACTION_SCREEN_OFF)
                    addAction(Intent.ACTION_USER_PRESENT)
                }
            runCatching {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
                } else {
                    registerReceiver(receiver, filter)
                }
                screenReceiver = receiver
            }
        }

        if (mediaSession == null) {
            runCatching {
                val volumeProvider =
                    // The control type is spelled out rather than left to the inherited constant,
                    // so it is obvious which of RELATIVE/ABSOLUTE/FIXED this session claims —
                    // the choice is what makes a volume press arrive here as an *adjustment*.
                    object : VolumeProviderCompat(
                        VolumeProviderCompat.VOLUME_CONTROL_RELATIVE,
                        VOLUME_CONTROL_MAX,
                        0,
                    ) {
                        override fun onAdjustVolume(direction: Int) {
                            stopEverything()
                        }

                        override fun onSetVolumeTo(volume: Int) {
                            stopEverything()
                        }
                    }
                mediaSession =
                    MediaSessionCompat(this, "MedGuardDoseAlarm").apply {
                        setPlaybackToRemote(volumeProvider)
                        isActive = true
                    }
            }
        }
    }

    private fun stopListeningForButtons() {
        screenReceiver?.let { runCatching { unregisterReceiver(it) } }
        screenReceiver = null

        mediaSession?.let {
            runCatching {
                it.isActive = false
                it.release()
            }
        }
        mediaSession = null
    }

    /**
     * The safety net. Whatever state the session is in and however the service came to be
     * destroyed, no player and no receiver survives this — the failure being guarded against is a
     * chime that outlives everything able to stop it.
     */
    override fun onDestroy() {
        stopRunnable?.let { stopHandler.removeCallbacks(it) }
        stopRunnable = null
        releasePlayer()
        stopListeningForButtons()
        session.takeAll()
        payloads.clear()
        foregroundKey = null
        super.onDestroy()
    }

    // Composition lives in `DoseNotifications` so the server's push (Sprint A4's
    // `MedGuardMessagingService`) posts an identical-looking alert with identical actions —
    // a caregiver must not be able to tell which mechanism woke them.
    private fun notificationId(occurrenceKey: String): Int =
        DoseNotifications.notificationId(occurrenceKey)

    private fun buildNotification(payload: AlarmPayload, ongoing: Boolean = true): android.app.Notification =
        DoseNotifications.build(this, payload, ongoing)
}
