package com.medguard.alarms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The first automated tests over this module's Kotlin, and they exist for a specific reason: the
 * bug they pin down — two doses due on the same minute leaving a looping `MediaPlayer` that
 * nothing could stop — reached a real household and rang for a whole Shabbat. It got there because
 * the state it corrupted lived in bare fields inside an Android `Service`, which nothing in this
 * repo could execute.
 *
 * `ChimeSession` holds that state and none of the Android, so these run on a plain JVM.
 */
class ChimeSessionTest {
    private val start = 1_000_000L

    @Test
    fun `first dose starts the sound`() {
        val session = ChimeSession()

        assertTrue(session.add("dose-a", start, 60))
        assertEquals(start + 60_000L, session.soundEndsAtMs())
    }

    /**
     * The reproduction of the Shabbat failure. Two alarms firing into the same service must
     * produce one sound — the second `add` returning false is what tells the service not to build
     * a second player over the top of the first.
     */
    @Test
    fun `a second dose at the same instant joins the sound rather than starting another`() {
        val session = ChimeSession()

        assertTrue(session.add("dose-a", start, 60))
        assertFalse(session.add("dose-b", start, 60))

        assertEquals(2, session.activeChimes().size)
        assertEquals(start + 60_000L, session.soundEndsAtMs())
    }

    @Test
    fun `a re-delivered intent for the same dose does not start a second sound`() {
        val session = ChimeSession()

        assertTrue(session.add("dose-a", start, 60))
        assertFalse(session.add("dose-a", start + 500L, 60))

        assertEquals(1, session.activeChimes().size)
        assertEquals(start + 500L + 60_000L, session.soundEndsAtMs())
    }

    /**
     * The other half of the old bug: the first alarm's stop callback fired at its own deadline and
     * killed a chime that had started later, cutting it short. The sound has to run to the latest
     * deadline, and each dose settles at its own.
     */
    @Test
    fun `a dose starting midway through another extends the sound to its own deadline`() {
        val session = ChimeSession()
        session.add("dose-a", start, 60)
        session.add("dose-b", start + 20_000L, 60)

        assertEquals(start + 80_000L, session.soundEndsAtMs())

        val expired = session.takeExpired(start + 60_000L)
        assertEquals(listOf("dose-a"), expired.map { it.occurrenceKey })
        assertFalse(session.isIdle())
        assertEquals(start + 80_000L, session.soundEndsAtMs())

        assertEquals(listOf("dose-b"), session.takeExpired(start + 80_000L).map { it.occurrenceKey })
        assertTrue(session.isIdle())
        assertNull(session.soundEndsAtMs())
    }

    @Test
    fun `removing one dose leaves the other sounding`() {
        val session = ChimeSession()
        session.add("dose-a", start, 60)
        session.add("dose-b", start, 60)

        assertEquals("dose-a", session.remove("dose-a")?.occurrenceKey)
        assertFalse(session.isIdle())
        assertTrue(session.contains("dose-b"))

        session.remove("dose-b")
        assertTrue(session.isIdle())
        assertNull(session.soundEndsAtMs())
    }

    @Test
    fun `removing a dose that is not sounding changes nothing`() {
        val session = ChimeSession()
        session.add("dose-a", start, 60)

        assertNull(session.remove("dose-z"))
        assertTrue(session.contains("dose-a"))
    }

    @Test
    fun `the foreground notification is the dose that started first, and moves when it ends`() {
        val session = ChimeSession()
        session.add("dose-a", start, 60)
        session.add("dose-b", start + 20_000L, 60)

        assertEquals("dose-a", session.foreground()?.occurrenceKey)

        session.takeExpired(start + 60_000L)
        assertEquals("dose-b", session.foreground()?.occurrenceKey)
    }

    @Test
    fun `taking everything clears the session`() {
        val session = ChimeSession()
        session.add("dose-a", start, 60)
        session.add("dose-b", start, 30)

        assertEquals(setOf("dose-a", "dose-b"), session.takeAll().map { it.occurrenceKey }.toSet())
        assertTrue(session.isIdle())
        assertNull(session.soundEndsAtMs())
        assertNull(session.foreground())
    }

    @Test
    fun `nothing is expired before its deadline`() {
        val session = ChimeSession()
        session.add("dose-a", start, 60)

        assertTrue(session.takeExpired(start + 59_999L).isEmpty())
        assertEquals(1, session.takeExpired(start + 60_000L).size)
    }

    // ---------------------------------------------------------------------
    // Clamping — the last line of defence before audio actually plays
    // ---------------------------------------------------------------------

    @Test
    fun `a length beyond the ceiling is clamped`() {
        val session = ChimeSession()
        session.add("dose-a", start, 86_400)

        assertEquals(start + ChimeSession.MAX_CHIME_DURATION_SECONDS * 1_000L, session.soundEndsAtMs())
    }

    @Test
    fun `a zero or negative length still rings long enough to notice`() {
        val session = ChimeSession()
        session.add("dose-a", start, 0)
        assertEquals(start + ChimeSession.MIN_CHIME_DURATION_SECONDS * 1_000L, session.soundEndsAtMs())

        val other = ChimeSession()
        other.add("dose-b", start, -5)
        assertEquals(start + ChimeSession.MIN_CHIME_DURATION_SECONDS * 1_000L, other.soundEndsAtMs())
    }

    @Test
    fun `clampDurationSeconds leaves an in-range length alone`() {
        assertEquals(60, ChimeSession.clampDurationSeconds(60))
        assertEquals(30, ChimeSession.clampDurationSeconds(30))
    }

    // ---------------------------------------------------------------------
    // "A button was pressed, even though no dose was marked"
    // ---------------------------------------------------------------------

    @Test
    fun `screen off silences immediately`() {
        val session = ChimeSession()
        session.add("dose-a", start, 60)

        assertTrue(session.shouldSilenceOnScreenEvent(ChimeSession.ACTION_SCREEN_OFF, start + 100L))
    }

    @Test
    fun `unlocking silences immediately`() {
        val session = ChimeSession()
        session.add("dose-a", start, 60)

        assertTrue(session.shouldSilenceOnScreenEvent(ChimeSession.ACTION_USER_PRESENT, start + 100L))
    }

    /**
     * The alert itself can light the screen. Without the grace window a high-importance
     * notification would silence its own alarm within a second — the opposite failure, and a worse
     * one for a medication app than ringing a little too long.
     */
    @Test
    fun `screen on is ignored inside the grace window and honoured outside it`() {
        val session = ChimeSession()
        session.add("dose-a", start, 60)

        assertFalse(session.shouldSilenceOnScreenEvent(ChimeSession.ACTION_SCREEN_ON, start))
        assertFalse(
            session.shouldSilenceOnScreenEvent(
                ChimeSession.ACTION_SCREEN_ON,
                start + ChimeSession.SCREEN_GRACE_MS - 1L,
            ),
        )
        assertTrue(
            session.shouldSilenceOnScreenEvent(
                ChimeSession.ACTION_SCREEN_ON,
                start + ChimeSession.SCREEN_GRACE_MS,
            ),
        )
    }

    /**
     * The grace window is measured from when the *sound* started, not from the most recent dose —
     * otherwise a second dose joining at 50 seconds would re-arm the window and make a genuine
     * button press stop working.
     */
    @Test
    fun `a later dose joining does not restart the grace window`() {
        val session = ChimeSession()
        session.add("dose-a", start, 60)
        session.add("dose-b", start + 50_000L, 60)

        assertTrue(session.shouldSilenceOnScreenEvent(ChimeSession.ACTION_SCREEN_ON, start + 50_000L))
    }

    @Test
    fun `an unrelated broadcast never silences`() {
        val session = ChimeSession()
        session.add("dose-a", start, 60)

        assertFalse(session.shouldSilenceOnScreenEvent("android.intent.action.BATTERY_LOW", start + 10_000L))
        assertFalse(session.shouldSilenceOnScreenEvent(null, start + 10_000L))
    }

    @Test
    fun `an idle session is silenced by nothing`() {
        val session = ChimeSession()

        assertFalse(session.shouldSilenceOnScreenEvent(ChimeSession.ACTION_SCREEN_OFF, start))
        assertFalse(session.shouldSilenceOnScreenEvent(ChimeSession.ACTION_SCREEN_ON, start))
    }

    @Test
    fun `the grace window is measured again after the session goes idle and restarts`() {
        val session = ChimeSession()
        session.add("dose-a", start, 60)
        session.takeAll()

        val restart = start + 500_000L
        session.add("dose-b", restart, 60)

        assertFalse(session.shouldSilenceOnScreenEvent(ChimeSession.ACTION_SCREEN_ON, restart))
        assertTrue(
            session.shouldSilenceOnScreenEvent(
                ChimeSession.ACTION_SCREEN_ON,
                restart + ChimeSession.SCREEN_GRACE_MS,
            ),
        )
    }
}
