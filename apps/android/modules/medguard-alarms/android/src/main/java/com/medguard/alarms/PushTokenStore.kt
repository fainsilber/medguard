package com.medguard.alarms

import android.content.Context

/**
 * The FCM registration token, kept where JS can read it on its next start.
 *
 * `onNewToken` can fire with the app process dead — after a reinstall, a restore, or Firebase
 * simply rotating it — and the token is useless until the server has it. Writing it down here
 * means the rotation survives until `pushRegistration.ts` next runs, rather than being lost and
 * leaving the device silently unreachable by push until something else happens to trigger a
 * re-registration.
 */
object PushTokenStore {
    private const val PREFS_NAME = "medguard_push"
    private const val KEY_TOKEN = "fcm_token"

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun save(context: Context, token: String) {
        // commit(), not apply(): this can be the last thing that runs before the process is
        // killed, and a token written nowhere is a device that stops receiving dose alerts.
        prefs(context).edit().putString(KEY_TOKEN, token).commit()
    }

    fun read(context: Context): String? = prefs(context).getString(KEY_TOKEN, null)
}
