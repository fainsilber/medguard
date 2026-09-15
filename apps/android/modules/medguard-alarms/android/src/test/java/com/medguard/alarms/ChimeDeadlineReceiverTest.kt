package com.medguard.alarms

import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * Fired by `AlarmManager` at `ChimeSession`'s deadline — the only way a Shabbat chime ever stops
 * itself, since the Shabbat channel has no Taken/Snooze button to fall back on
 * (`DoseAlarmService.ACTION_CHECK_DEADLINE`). This receiver's whole job is handing that moment to
 * `DoseAlarmService`; the decision of what to actually stop lives in `ChimeSession`/`onDeadlineReached`.
 */
@RunWith(RobolectricTestRunner::class)
class ChimeDeadlineReceiverTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val application: Application = ApplicationProvider.getApplicationContext()

    @Test
    fun `starts DoseAlarmService with ACTION_CHECK_DEADLINE`() {
        ChimeDeadlineReceiver().onReceive(context, Intent())

        val started = shadowOf(application).nextStartedService
        assertEquals(DoseAlarmService::class.java.name, started?.component?.className)
        assertEquals(DoseAlarmService.ACTION_CHECK_DEADLINE, started?.action)
    }
}
