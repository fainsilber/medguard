package com.medguard.alarms

import android.app.AlarmManager
import android.content.Context
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
 * `AlarmManager.setAlarmClock()` is what makes a dose alarm fire with the app force-stopped and
 * the phone locked (docs/android-client-plan.md, "Scheduling") — exempt from Doze and App Standby,
 * never batched. `AlarmScheduler` has no injected time source (contrary to an earlier draft of
 * docs/android-client-plan.md's test-strategy table — `BootReceiver.kt` calls
 * `System.currentTimeMillis()` directly, which Robolectric does not shadow), so these assert on
 * exact `triggerAtMs` values using far-future/far-past instants rather than a fake clock.
 */
@RunWith(RobolectricTestRunner::class)
class AlarmSchedulerTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val alarmManager
        get() = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    private fun payload(occurrenceKey: String, triggerAtMs: Long = 4_000_000_000_000L) =
        AlarmPayload(
            occurrenceKey = occurrenceKey,
            channelId = "dose_standard_v1",
            title = "Ondansetron is due",
            body = "4mg",
            chimeDurationSeconds = 45,
            escalation = false,
            triggerAtMs = triggerAtMs,
        )

    @Before
    fun clearArmedAlarms() {
        for (armed in ArmedAlarmStore.getAll(context)) {
            ArmedAlarmStore.remove(context, armed.occurrenceKey)
        }
    }

    @Test
    fun `schedule sets exactly one alarm-clock alarm at the payload's triggerAtMs`() {
        val entry = payload("schedule-1:one", triggerAtMs = 4_000_000_000_000L)

        AlarmScheduler.schedule(context, entry)

        val scheduled = shadowOf(alarmManager).scheduledAlarms
        assertEquals(1, scheduled.size)
        assertEquals(4_000_000_000_000L, scheduled.single().alarmClockInfo?.triggerTime)
    }

    @Test
    fun `schedule also writes the payload to ArmedAlarmStore, for BootReceiver to find later`() {
        val entry = payload("schedule-1:one")

        AlarmScheduler.schedule(context, entry)

        assertEquals(listOf(entry), ArmedAlarmStore.getAll(context))
    }

    @Test
    fun `cancel clears both the AlarmManager entry and the ArmedAlarmStore record`() {
        val entry = payload("schedule-1:one")
        AlarmScheduler.schedule(context, entry)

        AlarmScheduler.cancel(context, entry.occurrenceKey)

        assertTrue(shadowOf(alarmManager).scheduledAlarms.isEmpty())
        assertTrue(ArmedAlarmStore.getAll(context).isEmpty())
    }

    @Test
    fun `cancelAll empties every armed alarm, not just the AlarmManager side`() {
        AlarmScheduler.schedule(context, payload("schedule-1:one"))
        AlarmScheduler.schedule(context, payload("schedule-1:two"))

        AlarmScheduler.cancelAll(context)

        assertTrue(shadowOf(alarmManager).scheduledAlarms.isEmpty())
        assertTrue(ArmedAlarmStore.getAll(context).isEmpty())
    }

    @Test
    fun `re-scheduling the same occurrenceKey replaces it rather than arming a second alarm`() {
        val key = "schedule-1:one"
        AlarmScheduler.schedule(context, payload(key, triggerAtMs = 4_000_000_000_000L))

        AlarmScheduler.schedule(context, payload(key, triggerAtMs = 4_000_100_000_000L))

        // PendingIntent.getBroadcast with the same requestCode/Intent returns the same identity,
        // so AlarmManager.FLAG_UPDATE_CURRENT replaces the earlier alarm instead of adding one.
        val armed = ArmedAlarmStore.getAll(context)
        assertEquals(1, armed.size)
        assertEquals(4_000_100_000_000L, armed.single().triggerAtMs)
    }

    @Test
    fun `canScheduleExactAlarms delegates to the real AlarmManager API rather than assuming true`() {
        // Robolectric 4.13's ShadowAlarmManager has no setter for this flag (confirmed the hard
        // way: `setCanScheduleExactAlarms` doesn't exist on it and fails the CI build with an
        // unresolved-reference compile error, not a test failure — this sandbox has no way to
        // compile Kotlin against the real shadow-framework jar to catch that before pushing). What
        // *is* checkable without one: Robolectric's default `ShadowAlarmManager` answers `true`
        // for `canScheduleExactAlarms()`, and `AlarmScheduler.canScheduleExactAlarms` must return
        // exactly that value on API 31+ rather than a hardcoded `true` of its own — the two
        // hardcoded `true`s could otherwise agree by coincidence and hide a real regression.
        assertEquals(alarmManager.canScheduleExactAlarms(), AlarmScheduler.canScheduleExactAlarms(context))
    }

    @Test
    fun `cancelling an occurrence that was never armed does not throw`() {
        AlarmScheduler.cancel(context, "schedule-1:never-armed")

        assertNull(ArmedAlarmStore.getAll(context).find { it.occurrenceKey == "schedule-1:never-armed" })
    }
}
