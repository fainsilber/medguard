package com.medguard.alarms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Fired by `AlarmManager` — possibly with the app process dead and the screen off. Starting a
 * foreground service from the background is normally restricted, but delivery of an exact alarm
 * is an explicit exemption (docs/android-client-plan.md, "The chime").
 */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val raw = intent.getStringExtra(AlarmScheduler.EXTRA_PAYLOAD) ?: return
        val payload = runCatching { AlarmPayload.fromJson(JSONObject(raw)) }.getOrNull() ?: return

        // The alarm fired: it's no longer "armed for the future" in the re-arm mirror. A fresh
        // arm for the next occurrence of the same schedule is JS's job on the next horizon pass.
        ArmedAlarmStore.remove(context, payload.occurrenceKey)

        val serviceIntent =
            Intent(context, DoseAlarmService::class.java).apply {
                putExtra(AlarmScheduler.EXTRA_PAYLOAD, raw)
            }
        ContextCompat.startForegroundService(context, serviceIntent)
    }
}
