package com.medguard.alarms

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Starts JavaScript with no UI, so a tap made while the app process was dead becomes a dose
 * within seconds instead of waiting for the next app launch.
 *
 * This is the gap Sprint A3 knowingly left open. A3's drain triggers — app launch, `AppState`
 * → `'active'`, and the native `onPendingAction` event — all need a JS runtime that already
 * exists, which covers a merely-locked phone but not a genuinely dead process. Within A3 that
 * cost only latency (the tap's timestamp is captured exactly either way). From A4 it can cost a
 * spurious escalation to the second caregiver's phone for a dose that was in fact given, because
 * the server learns about the dose only when the record syncs.
 *
 * Deliberately built here rather than in A3: the headless bootstrap and the FCM handler are the
 * same machinery, and building it once for both is why A3 deferred it.
 *
 * Kotlin still writes nothing (delta AD2). This starts the JS task; the task calls
 * `AlarmEngine.applyPendingActions()`, which converts intent into domain state through the one
 * tested repository transaction, exactly as it does at app launch.
 */
class MedGuardHeadlessService : HeadlessJsTaskService() {
    // Both types nullable to match HeadlessJsTaskService's actual signature exactly — Kotlin
    // requires an exact match to count as an override, and `Intent`/`HeadlessJsTaskConfig`
    // (non-null) does not satisfy `Intent?`/`HeadlessJsTaskConfig?`.
    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
        if (intent == null) return null
        return HeadlessJsTaskConfig(
            TASK_NAME,
            intent.extras?.let { Arguments.fromBundle(it) } ?: Arguments.createMap(),
            TASK_TIMEOUT_MS,
            // Allowed in the foreground too: the receiver starts this whenever no JS runtime is
            // registered, and "no runtime" and "no visible activity" are not the same state.
            true,
        )
    }

    companion object {
        /** Must match `AppRegistry.registerHeadlessTask` in `apps/android/index.ts`. */
        const val TASK_NAME = "MedGuardPendingActions"

        /**
         * Generous, because the task's real work is a database write followed by a sync attempt
         * over whatever connection a locked phone has. Well inside the `shortService` budget.
         */
        private const val TASK_TIMEOUT_MS = 30_000L
    }
}
