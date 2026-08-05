package com.medguard.alarms

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class PendingAction(val occurrenceKey: String, val action: String, val tappedAtMs: Long)

/**
 * The durable landing spot for "the user tapped Taken/Snooze", written the instant the tap
 * happens, from a notification action `BroadcastReceiver` that may be the only code running —
 * the app process can be dead. `commit()` (synchronous), not `apply()`, because durability at
 * the tap instant is the entire point (AD2, docs/android-client-plan.md, "Acting on a
 * notification when the app process is dead").
 *
 * Kotlin never converts an entry here into an `IntakeLog` — that would be a second, uncovered
 * implementation of the append-only ledger. `drainAll()` is called from JS
 * (`medguard-alarms`'s `drainPendingActions()`), and the caller is responsible for feeding each
 * entry through the shared `recordDose()` repository call before it's considered handled.
 */
object PendingActionStore {
    private const val PREFS_NAME = "medguard_pending_actions"
    private const val KEY_ENTRIES = "entries"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun add(context: Context, occurrenceKey: String, action: String, tappedAtMs: Long) {
        val store = prefs(context)
        val existing = JSONArray(store.getString(KEY_ENTRIES, "[]"))
        val entry =
            JSONObject()
                .put("occurrenceKey", occurrenceKey)
                .put("action", action)
                .put("tappedAtMs", tappedAtMs)
        existing.put(entry)
        store.edit().putString(KEY_ENTRIES, existing.toString()).commit()
    }

    /** Reads and clears atomically enough for this store's purpose: read-then-overwrite under one commit. */
    fun drainAll(context: Context): List<PendingAction> {
        val store = prefs(context)
        val existing = JSONArray(store.getString(KEY_ENTRIES, "[]"))
        val actions = mutableListOf<PendingAction>()
        for (i in 0 until existing.length()) {
            val entry = existing.getJSONObject(i)
            actions.add(
                PendingAction(
                    occurrenceKey = entry.getString("occurrenceKey"),
                    action = entry.getString("action"),
                    tappedAtMs = entry.getLong("tappedAtMs"),
                ),
            )
        }
        store.edit().putString(KEY_ENTRIES, "[]").commit()
        return actions
    }
}
