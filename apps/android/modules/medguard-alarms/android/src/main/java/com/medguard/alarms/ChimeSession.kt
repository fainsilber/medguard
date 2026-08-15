package com.medguard.alarms

/**
 * Which dose alerts are currently sounding, when the sound stops, and what silences it early.
 *
 * **Why this is a separate class with no Android imports.** `DoseAlarmService` used to hold this
 * state in three bare fields — one `MediaPlayer`, one stop `Runnable`, one payload — which is
 * correct only if alarms never overlap. They do: a household gives several medicines at 08:00, so
 * two `AlarmReceiver`s start the *same* service instance and `onStartCommand` runs twice. The
 * second call reassigned `mediaPlayer` over a player that was still looping on `USAGE_ALARM` and
 * that nothing held a reference to any more, so nothing could ever stop it. It rang until the
 * process died. That is what a Shabbat of continuous alerts actually was, and on Shabbat the
 * notification carries no buttons to press and force-stopping the app is not an option.
 *
 * Everything here is a decision — no player, no notifications, no `Context` — so the behaviour can
 * be proven on the JVM rather than only on a phone on a Shabbat. `ChimeSessionTest` is where the
 * cases live.
 *
 * The rules it encodes:
 *
 *  - **One sound, however many doses.** Adding an occurrence returns whether the caller must
 *    *start* the shared player; a second concurrent dose returns `false` and simply joins.
 *  - **The sound runs to the latest deadline.** A dose that starts ringing partway through
 *    another's chime still gets its own full length, and the earlier alarm's deadline no longer
 *    cuts it off.
 *  - **A re-delivered intent is idempotent.** Re-adding a key already present updates it in place
 *    rather than stacking a second entry.
 *  - **The length is clamped.** Whatever the payload says, the sound cannot outlive
 *    [MAX_CHIME_DURATION_SECONDS]. This mirrors `chimeDurationSecondsFor()` in
 *    `packages/shared/src/chime.ts`; it is deliberately duplicated rather than trusted, because
 *    this is the last point before audio actually plays.
 */
class ChimeSession(private val screenGraceMs: Long = SCREEN_GRACE_MS) {
    companion object {
        /** Mirrors `MIN_CHIME_DURATION_SECONDS` / `MAX_CHIME_DURATION_SECONDS` in @medguard/shared. */
        const val MIN_CHIME_DURATION_SECONDS = 5
        const val MAX_CHIME_DURATION_SECONDS = 180

        /**
         * How long after a chime starts a screen-*on* event is ignored.
         *
         * A high-importance notification can light the screen by itself, and without this window
         * the alarm would silence itself within a second of starting — the opposite failure, and
         * a far more dangerous one for a medication app than ringing slightly too long. Screen-off
         * and unlock are not subject to it: neither happens without a person.
         */
        const val SCREEN_GRACE_MS = 3_000L

        const val ACTION_SCREEN_ON = "android.intent.action.SCREEN_ON"
        const val ACTION_SCREEN_OFF = "android.intent.action.SCREEN_OFF"
        const val ACTION_USER_PRESENT = "android.intent.action.USER_PRESENT"

        fun clampDurationSeconds(seconds: Int): Int =
            seconds.coerceIn(MIN_CHIME_DURATION_SECONDS, MAX_CHIME_DURATION_SECONDS)
    }

    /** One dose currently sounding. `expiresAtMs` is already clamped. */
    data class ActiveChime(
        val occurrenceKey: String,
        val startedAtMs: Long,
        val expiresAtMs: Long,
    )

    // Insertion-ordered: `foreground()` returns the alarm whose notification is holding the
    // service up, and "the one that started first" is the stable, obvious answer.
    private val active = LinkedHashMap<String, ActiveChime>()

    /** When the shared player was started, for the screen-event grace window. */
    private var soundStartedAtMs: Long? = null

    /**
     * Registers an occurrence as sounding.
     *
     * @return true when the caller must start the shared player — i.e. this took the session from
     *   idle to active. False means a player is already running and this dose joins it.
     */
    fun add(occurrenceKey: String, startedAtMs: Long, durationSeconds: Int): Boolean {
        val wasIdle = active.isEmpty()
        active[occurrenceKey] =
            ActiveChime(
                occurrenceKey = occurrenceKey,
                startedAtMs = startedAtMs,
                expiresAtMs = startedAtMs + clampDurationSeconds(durationSeconds) * 1_000L,
            )
        if (wasIdle) {
            soundStartedAtMs = startedAtMs
        }
        return wasIdle
    }

    fun remove(occurrenceKey: String): ActiveChime? {
        val removed = active.remove(occurrenceKey)
        if (active.isEmpty()) {
            soundStartedAtMs = null
        }
        return removed
    }

    /** Everything currently sounding, in the order it started. */
    fun activeChimes(): List<ActiveChime> = active.values.toList()

    fun contains(occurrenceKey: String): Boolean = active.containsKey(occurrenceKey)

    fun isIdle(): Boolean = active.isEmpty()

    /**
     * Removes and returns every occurrence whose own deadline has passed, so the caller can
     * re-post each one's notification as a plain, dismissible one.
     */
    fun takeExpired(nowMs: Long): List<ActiveChime> {
        val expired = active.values.filter { it.expiresAtMs <= nowMs }
        for (chime in expired) {
            active.remove(chime.occurrenceKey)
        }
        if (active.isEmpty()) {
            soundStartedAtMs = null
        }
        return expired
    }

    /** Clears everything — the caller is stopping the sound outright. */
    fun takeAll(): List<ActiveChime> {
        val all = active.values.toList()
        active.clear()
        soundStartedAtMs = null
        return all
    }

    /**
     * When the shared sound should stop: the *latest* deadline among active alarms, or null when
     * nothing is sounding. Taking the latest rather than the earliest is what stops a dose that
     * began ringing first from cutting a later one off partway through.
     */
    fun soundEndsAtMs(): Long? = active.values.maxOfOrNull { it.expiresAtMs }

    /** The alarm whose notification is the foreground-service one. */
    fun foreground(): ActiveChime? = active.values.firstOrNull()

    /**
     * Whether a screen broadcast counts as "a caregiver pressed something", per the decision that
     * a physical button silences a weekday alert even when no dose is marked.
     *
     * Screen-off and unlock are unambiguous. Screen-on is honoured only outside the grace window,
     * because the alert itself can cause one.
     */
    fun shouldSilenceOnScreenEvent(action: String?, nowMs: Long): Boolean {
        if (active.isEmpty()) {
            return false
        }
        return when (action) {
            ACTION_SCREEN_OFF, ACTION_USER_PRESENT -> true
            ACTION_SCREEN_ON -> {
                val startedAtMs = soundStartedAtMs ?: return false
                nowMs - startedAtMs >= screenGraceMs
            }
            else -> false
        }
    }
}
