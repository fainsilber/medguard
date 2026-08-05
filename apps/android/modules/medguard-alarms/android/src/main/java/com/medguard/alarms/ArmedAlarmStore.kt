package com.medguard.alarms

import android.content.Context
import org.json.JSONObject

/**
 * A local mirror of "what's currently armed", keyed by `occurrenceKey`. Not a copy of the
 * domain schedule — just enough to re-issue `setAlarmClock()` calls after `BootReceiver` fires,
 * since alarms do not survive a reboot and a household that reboots a phone and quietly stops
 * getting dose alarms is the worst failure this app can have
 * (docs/android-client-plan.md, "Re-arming").
 *
 * Full horizon re-materialization (schedules -> the next 48h of occurrences) stays JS's job on
 * every sync pull and app foreground; this store only prevents losing alarms that were already
 * armed at the moment of reboot.
 */
object ArmedAlarmStore {
    private const val PREFS_NAME = "medguard_armed_alarms"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun put(context: Context, payload: AlarmPayload) {
        prefs(context).edit().putString(payload.occurrenceKey, payload.toJson().toString()).commit()
    }

    fun remove(context: Context, occurrenceKey: String) {
        prefs(context).edit().remove(occurrenceKey).commit()
    }

    fun getAll(context: Context): List<AlarmPayload> =
        prefs(context).all.values.mapNotNull { value ->
            (value as? String)?.let { runCatching { AlarmPayload.fromJson(JSONObject(it)) }.getOrNull() }
        }
}
