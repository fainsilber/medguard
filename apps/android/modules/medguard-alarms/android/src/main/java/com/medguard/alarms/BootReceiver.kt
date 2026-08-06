package com.medguard.alarms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Alarms do not survive a reboot, a clock change, or `MY_PACKAGE_REPLACED` (an app update). A
 * household that reboots a phone and quietly stops getting dose alarms is the worst failure this
 * app can have (docs/android-client-plan.md, "Re-arming"), so this re-issues every alarm that
 * was armed at the moment it stopped being armed.
 *
 * Alarms already past their `triggerAtMs` are dropped rather than fired late — a stale alarm
 * firing hours after the fact would be confusing, not helpful; the server-side escalation path
 * (which does not depend on this device) is what covers a device that was off long enough to
 * miss a dose window.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED,
            -> reArmAll(context)
        }
    }

    private fun reArmAll(context: Context) {
        val now = System.currentTimeMillis()
        for (payload in ArmedAlarmStore.getAll(context)) {
            if (payload.triggerAtMs <= now) {
                ArmedAlarmStore.remove(context, payload.occurrenceKey)
                continue
            }
            AlarmScheduler.schedule(context, payload)
        }
    }
}
