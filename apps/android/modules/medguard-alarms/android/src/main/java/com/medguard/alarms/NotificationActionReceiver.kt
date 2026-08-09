package com.medguard.alarms

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Handles the "Taken" / "Snooze" notification actions. May run with the app process dead and
 * the phone locked. It captures intent only — *"the user pressed Taken on occurrence X at
 * instant T"* — durable the instant the tap happens via `PendingActionStore.add()`'s `commit()`.
 *
 * It deliberately does not write an `IntakeLog`, a `DoseSnooze`, or touch inventory: that would
 * be a second, uncovered implementation of the append-only ledger (AD2). Converting captured
 * intent into domain state happens in JS, through the one tested `recordDose()` repository call.
 *
 * Two paths get it there, and the order matters. If a JS runtime happens to be alive — the common
 * case for a phone that is merely locked rather than freshly booted — `emitPendingAction` hands
 * the tap over immediately and the dose is logged and synced within seconds. If it is not, the
 * `PendingActionStore` row above is the whole record, and it is applied at the next app launch or
 * foreground. A `HeadlessJsTaskService` would close that last gap; it is deferred to A4, where the
 * headless bootstrap gets built once and shared with the FCM data-message handler A4 needs anyway.
 */
class NotificationActionReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_TAKEN = "com.medguard.alarms.action.TAKEN"
        const val ACTION_SNOOZE = "com.medguard.alarms.action.SNOOZE"
        const val EXTRA_OCCURRENCE_KEY = "com.medguard.alarms.extra.OCCURRENCE_KEY"
        const val EXTRA_NOTIFICATION_ID = "com.medguard.alarms.extra.NOTIFICATION_ID"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val occurrenceKey = intent.getStringExtra(EXTRA_OCCURRENCE_KEY) ?: return
        val tappedAtMs = System.currentTimeMillis()

        val action =
            when (intent.action) {
                ACTION_TAKEN -> "taken"
                ACTION_SNOOZE -> "snooze"
                else -> return
            }

        // Durable first, notify second — never the reverse. If the process dies between these two
        // lines the tap is still on disk; if they were swapped, a JS listener that received the
        // event and then died would leave no record anywhere that the caregiver had acted.
        PendingActionStore.add(context, occurrenceKey, action, tappedAtMs)
        MedGuardAlarmsModule.emitPendingAction(occurrenceKey, action, tappedAtMs)

        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1)
        if (notificationId != -1) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.cancel(notificationId)
        }

        context.stopService(Intent(context, DoseAlarmService::class.java))
    }
}
