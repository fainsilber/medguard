package com.medguard.alarms

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

data class PendingAction(
    val id: String,
    val occurrenceKey: String,
    val action: String,
    val tappedAtMs: Long,
)

/**
 * The durable landing spot for "the user tapped Taken/Snooze", written the instant the tap
 * happens, from a notification action `BroadcastReceiver` that may be the only code running —
 * the app process can be dead. `commit()` (synchronous), not `apply()`, because durability at
 * the tap instant is the entire point (AD2, docs/android-client-plan.md, "Acting on a
 * notification when the app process is dead").
 *
 * Kotlin never converts an entry here into an `IntakeLog` — that would be a second, uncovered
 * implementation of the append-only ledger. `readAll()` is called from JS
 * (`medguard-alarms`'s `readPendingActions()`), and the caller is responsible for feeding each
 * entry through the shared `recordDose()` repository call before it's considered handled.
 *
 * **Read and acknowledge are deliberately separate operations.** An earlier version drained
 * destructively — read-and-clear in one call — which meant that if the app was killed between
 * the read and the write of the resulting `IntakeLog` (a real possibility: the drain runs during
 * app startup, exactly when Android is most willing to kill things), the caregiver's tap was
 * gone with no record anywhere that it had happened. That is the loss safety invariant 7 forbids.
 * JS now acks only after the dose has actually committed, so a crash mid-apply costs a repeated
 * read, never a lost dose. The redundant read is harmless because the applier dedupes against
 * the log it already wrote.
 */
object PendingActionStore {
    private const val TAG = "MedGuardAlarms"
    private const val PREFS_NAME = "medguard_pending_actions"
    private const val KEY_ENTRIES = "entries"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun add(context: Context, occurrenceKey: String, action: String, tappedAtMs: Long) {
        // `commit()`'s return value was previously discarded — this durable write is the entire
        // safety guarantee this class exists for, so a silent `false` here (a real possibility:
        // `SharedPreferences.Editor.commit()` can fail) must not disappear without a trace. Logged
        // rather than asserted/thrown: this call has no caller in a position to handle a retry
        // (it's the last line of defense in a BroadcastReceiver with no live JS runtime to surface
        // an error to), so a loud logcat line is the most this call site can do.
        val store = prefs(context)
        val existing = JSONArray(store.getString(KEY_ENTRIES, "[]"))
        val entry =
            JSONObject()
                // Identity has to survive the process dying between read and ack, so it cannot be
                // an array index or an in-memory counter. Occurrence + action + tap instant is
                // unique in practice: the same button on the same dose in the same millisecond is
                // one tap, and collapsing a genuine double-tap is the correct outcome anyway.
                .put("id", "$occurrenceKey|$action|$tappedAtMs")
                .put("occurrenceKey", occurrenceKey)
                .put("action", action)
                .put("tappedAtMs", tappedAtMs)
        existing.put(entry)
        val ok = store.edit().putString(KEY_ENTRIES, existing.toString()).commit()
        Log.i(TAG, "PendingActionStore.add(occurrenceKey=$occurrenceKey, action=$action): commit()=$ok, entries now ${existing.length()}")
    }

    /** Non-destructive: entries stay until `ack()` confirms JS has committed them. */
    fun readAll(context: Context): List<PendingAction> {
        val existing = JSONArray(prefs(context).getString(KEY_ENTRIES, "[]"))
        val actions = mutableListOf<PendingAction>()
        for (i in 0 until existing.length()) {
            val entry = existing.getJSONObject(i)
            val occurrenceKey = entry.getString("occurrenceKey")
            val action = entry.getString("action")
            val tappedAtMs = entry.getLong("tappedAtMs")
            actions.add(
                PendingAction(
                    // Tolerates entries written by a pre-A3 build, which had no id field: an app
                    // update must not strand a tap that was already captured.
                    id = entry.optString("id", "$occurrenceKey|$action|$tappedAtMs"),
                    occurrenceKey = occurrenceKey,
                    action = action,
                    tappedAtMs = tappedAtMs,
                ),
            )
        }
        return actions
    }

    /**
     * Drops exactly the entries JS has finished applying, by id — never "everything that was
     * there", because a tap can land between the read and the ack and must not be discarded
     * unseen.
     */
    fun ack(context: Context, ids: Collection<String>) {
        if (ids.isEmpty()) return

        val store = prefs(context)
        val existing = JSONArray(store.getString(KEY_ENTRIES, "[]"))
        val remaining = JSONArray()
        for (i in 0 until existing.length()) {
            val entry = existing.getJSONObject(i)
            val occurrenceKey = entry.getString("occurrenceKey")
            val action = entry.getString("action")
            val tappedAtMs = entry.getLong("tappedAtMs")
            val id = entry.optString("id", "$occurrenceKey|$action|$tappedAtMs")
            if (!ids.contains(id)) {
                remaining.put(entry)
            }
        }
        store.edit().putString(KEY_ENTRIES, remaining.toString()).commit()
    }
}
