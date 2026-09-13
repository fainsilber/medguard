package com.medguard.alarms

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * A durable, capped record of what `DoseAlarmService` actually did — independent of whether any JS
 * runtime existed to see it, and of the app's in-memory `appLog` (`src/logging/appLog.ts`), which
 * only sees what JS itself does (sync, the `stopChime` bridge call) and is wiped on every process
 * restart.
 *
 * This exists because a Shabbat chime rings entirely inside this service with no JS involved at
 * all — scheduling happens ahead of time, but the ring, its notification, and its self-stop timer
 * are pure `DoseAlarmService`/`ChimeSession` state. When one phone's chime failed to stop and
 * another's didn't, there was no record anywhere of what the timer, the player, or the service's
 * own lifecycle had actually done. `SharedPreferences` (like `PendingActionStore`) rather than a
 * plain field: it needs to survive the same process death/restart it exists to diagnose.
 *
 * Best-effort by design — `apply()`, not `commit()`. Losing a diagnostic line to a rare race is an
 * acceptable cost; blocking `DoseAlarmService`'s main-thread callbacks on a disk write on every
 * dose is not.
 */
object NativeAlarmLogStore {
    private const val PREFS_NAME = "medguard_native_alarm_log"
    private const val KEY_ENTRIES = "entries"

    /** Mirrors `LogBuffer`'s default cap (`packages/shared/src/log.ts`) these entries merge into. */
    private const val MAX_ENTRIES = 300

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun append(context: Context, level: String, message: String, data: Map<String, Any?> = emptyMap()) {
        val store = prefs(context)
        val existing = JSONArray(store.getString(KEY_ENTRIES, "[]"))
        val entry =
            JSONObject()
                .put("atMs", System.currentTimeMillis())
                .put("level", level)
                .put("message", message)
        val nonNullData = data.filterValues { it != null }
        if (nonNullData.isNotEmpty()) {
            val dataJson = JSONObject()
            for ((key, value) in nonNullData) {
                dataJson.put(key, value)
            }
            entry.put("data", dataJson)
        }
        existing.put(entry)

        // Ring-buffer trim, oldest first — same shape as the JS-side LogBuffer these merge into.
        val trimmed =
            if (existing.length() > MAX_ENTRIES) {
                JSONArray().apply {
                    for (i in (existing.length() - MAX_ENTRIES) until existing.length()) {
                        put(existing.get(i))
                    }
                }
            } else {
                existing
            }
        store.edit().putString(KEY_ENTRIES, trimmed.toString()).apply()
    }

    fun readAll(context: Context): List<JSONObject> {
        val existing = JSONArray(prefs(context).getString(KEY_ENTRIES, "[]"))
        return (0 until existing.length()).map { existing.getJSONObject(it) }
    }

    fun clear(context: Context) {
        prefs(context).edit().remove(KEY_ENTRIES).apply()
    }
}
