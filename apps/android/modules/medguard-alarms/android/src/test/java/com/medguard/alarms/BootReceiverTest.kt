package com.medguard.alarms

import android.app.AlarmManager
import android.content.Context
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * A household that reboots a phone and quietly stops getting dose alarms is the worst failure
 * this app can have (the class's own doc comment) — alarms do not survive a reboot, so this is
 * what re-issues every one that was armed at the moment it stopped being armed. Proven here
 * without a phone, standing in for Sprint A's manual QA item 5.
 *
 * `AlarmScheduler` has no injected time source — `System.currentTimeMillis()` is called directly
 * and Robolectric does not shadow it — so "future" and "past" here are computed relative to the
 * real wall clock at test time, far enough out that test execution time can't flip which side of
 * the boundary an instant falls on.
 *
 * The starting state each test seeds is what a reboot actually leaves behind: `ArmedAlarmStore`'s
 * `SharedPreferences` record survives (it's on disk), but the `AlarmManager` registration does
 * not — seeding directly through `ArmedAlarmStore.put`, not `AlarmScheduler.schedule`, is what
 * models that correctly.
 */
@RunWith(RobolectricTestRunner::class)
class BootReceiverTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val alarmManager
        get() = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

    @Before
    fun clearArmedAlarms() {
        for (armed in ArmedAlarmStore.getAll(context)) {
            ArmedAlarmStore.remove(context, armed.occurrenceKey)
        }
    }

    private fun payload(occurrenceKey: String, triggerAtMs: Long) =
        AlarmPayload(
            occurrenceKey = occurrenceKey,
            channelId = "dose_standard_v1",
            title = "Ondansetron is due",
            body = "4mg",
            chimeDurationSeconds = 45,
            escalation = false,
            triggerAtMs = triggerAtMs,
        )

    @Test
    fun `re-arms a future alarm through AlarmManager on BOOT_COMPLETED`() {
        val future = System.currentTimeMillis() + 10_000_000L
        ArmedAlarmStore.put(context, payload("schedule-1:future", future))

        BootReceiver().onReceive(context, Intent(Intent.ACTION_BOOT_COMPLETED))

        val scheduled = shadowOf(alarmManager).scheduledAlarms
        assertEquals(1, scheduled.size)
        assertEquals(future, scheduled.single().alarmClockInfo?.triggerTime)
    }

    @Test
    fun `drops an alarm whose trigger instant has already passed, rather than firing it late`() {
        val past = System.currentTimeMillis() - 10_000_000L
        ArmedAlarmStore.put(context, payload("schedule-1:past", past))

        BootReceiver().onReceive(context, Intent(Intent.ACTION_BOOT_COMPLETED))

        assertTrue(shadowOf(alarmManager).scheduledAlarms.isEmpty())
        assertTrue(ArmedAlarmStore.getAll(context).isEmpty())
    }

    @Test
    fun `re-arms what is still future and drops what is past, in the same pass`() {
        val past = System.currentTimeMillis() - 10_000_000L
        val future = System.currentTimeMillis() + 10_000_000L
        ArmedAlarmStore.put(context, payload("schedule-1:past", past))
        ArmedAlarmStore.put(context, payload("schedule-1:future", future))

        BootReceiver().onReceive(context, Intent(Intent.ACTION_BOOT_COMPLETED))

        assertEquals(listOf("schedule-1:future"), ArmedAlarmStore.getAll(context).map { it.occurrenceKey })
        assertEquals(1, shadowOf(alarmManager).scheduledAlarms.size)
    }

    @Test
    fun `also re-arms on LOCKED_BOOT_COMPLETED, MY_PACKAGE_REPLACED, and a clock or timezone change`() {
        for (action in listOf(
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED,
        )) {
            clearArmedAlarms()
            val future = System.currentTimeMillis() + 10_000_000L
            ArmedAlarmStore.put(context, payload("schedule-1:$action", future))

            BootReceiver().onReceive(context, Intent(action))

            assertEquals("expected re-arm on $action", 1, shadowOf(alarmManager).scheduledAlarms.size)
        }
    }

    @Test
    fun `an unrelated broadcast does not touch the armed alarms`() {
        val future = System.currentTimeMillis() + 10_000_000L
        ArmedAlarmStore.put(context, payload("schedule-1:future", future))

        BootReceiver().onReceive(context, Intent("android.intent.action.BATTERY_LOW"))

        assertTrue(shadowOf(alarmManager).scheduledAlarms.isEmpty())
        assertEquals(listOf("schedule-1:future"), ArmedAlarmStore.getAll(context).map { it.occurrenceKey })
    }
}
