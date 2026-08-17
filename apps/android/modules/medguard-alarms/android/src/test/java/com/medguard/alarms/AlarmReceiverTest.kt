package com.medguard.alarms

import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * Fired by `AlarmManager`, possibly with the app process dead and the screen off — this is what
 * turns a scheduled alarm into an actual chime by starting `DoseAlarmService`. Small (29 lines),
 * but a malformed payload reaching it must fail safe: no service, no crash, and the armed-alarm
 * mirror left alone rather than dropping a record for an occurrence that never actually fired.
 */
@RunWith(RobolectricTestRunner::class)
class AlarmReceiverTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val application: Application = ApplicationProvider.getApplicationContext()

    @Before
    fun clearArmedAlarms() {
        for (armed in ArmedAlarmStore.getAll(context)) {
            ArmedAlarmStore.remove(context, armed.occurrenceKey)
        }
    }

    private fun payload(occurrenceKey: String) =
        AlarmPayload(
            occurrenceKey = occurrenceKey,
            channelId = "dose_standard_v1",
            title = "Ondansetron is due",
            body = "4mg",
            chimeDurationSeconds = 45,
            escalation = false,
            triggerAtMs = 4_000_000_000_000L,
        )

    private fun fireIntent(rawPayload: String?): Intent =
        Intent(context, AlarmReceiver::class.java).apply {
            if (rawPayload != null) putExtra(AlarmScheduler.EXTRA_PAYLOAD, rawPayload)
        }

    @Test
    fun `a valid payload starts DoseAlarmService and clears the armed-alarm mirror`() {
        val entry = payload("schedule-1:one")
        ArmedAlarmStore.put(context, entry)

        AlarmReceiver().onReceive(context, fireIntent(entry.toJson().toString()))

        val started = shadowOf(application).nextStartedService
        assertEquals(DoseAlarmService::class.java.name, started?.component?.className)
        assertEquals(entry.toJson().toString(), started?.getStringExtra(AlarmScheduler.EXTRA_PAYLOAD))
        assertTrue(ArmedAlarmStore.getAll(context).isEmpty())
    }

    @Test
    fun `a missing payload extra starts nothing`() {
        AlarmReceiver().onReceive(context, fireIntent(null))

        assertNull(shadowOf(application).nextStartedService)
    }

    @Test
    fun `a malformed payload starts nothing and leaves the armed-alarm mirror untouched`() {
        val entry = payload("schedule-1:one")
        ArmedAlarmStore.put(context, entry)

        AlarmReceiver().onReceive(context, fireIntent("not valid json"))

        assertNull(shadowOf(application).nextStartedService)
        // Untouched, not cleared — this alarm never actually fired as far as the mirror is
        // concerned, so BootReceiver must still see it as armed after a reboot.
        assertEquals(listOf(entry), ArmedAlarmStore.getAll(context))
    }
}
