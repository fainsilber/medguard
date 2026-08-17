package com.medguard.alarms

import android.app.Application
import android.app.Notification
import android.app.NotificationManager
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
 * The automatable half of manual QA item 4 (tapping "Taken" from the lock screen with the app
 * force-stopped): this receiver's whole job is capturing intent durably before anything else
 * happens, per its own doc comment — "durable first, notify second, never the reverse." What
 * matters here is exactly that ordering and exactly that durability, not the UI it triggers.
 *
 * `MedGuardAlarmsModule.hasLiveRuntime()` is false by default under Robolectric — there is no
 * React Native instance manager running, which is also the real, normal state for a phone that
 * has been locked for hours. That makes the "no live runtime" branch (start
 * `MedGuardHeadlessService`) the one these tests naturally exercise, which is also the one Sprint
 * A4 added and the one manual QA item 4 is about.
 */
@RunWith(RobolectricTestRunner::class)
class NotificationActionReceiverTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val application: Application = ApplicationProvider.getApplicationContext()

    @Before
    fun clearPendingActions() {
        PendingActionStore.ack(context, PendingActionStore.readAll(context).map { it.id })
    }

    private fun actionIntent(action: String, occurrenceKey: String?, notificationId: Int = -1): Intent =
        Intent(action).apply {
            if (occurrenceKey != null) putExtra(NotificationActionReceiver.EXTRA_OCCURRENCE_KEY, occurrenceKey)
            if (notificationId != -1) putExtra(NotificationActionReceiver.EXTRA_NOTIFICATION_ID, notificationId)
        }

    @Test
    fun `writes a durable pending action for a Taken tap, at the tap instant`() {
        val before = System.currentTimeMillis()

        NotificationActionReceiver().onReceive(
            context,
            actionIntent(NotificationActionReceiver.ACTION_TAKEN, "schedule-1:one"),
        )

        val after = System.currentTimeMillis()
        val actions = PendingActionStore.readAll(context)
        assertEquals(1, actions.size)
        val action = actions.single()
        assertEquals("schedule-1:one", action.occurrenceKey)
        assertEquals("taken", action.action)
        assertTrue(action.tappedAtMs in before..after)
    }

    @Test
    fun `writes snooze the same way as taken, distinguished only by the action field`() {
        NotificationActionReceiver().onReceive(
            context,
            actionIntent(NotificationActionReceiver.ACTION_SNOOZE, "schedule-1:one"),
        )

        assertEquals("snooze", PendingActionStore.readAll(context).single().action)
    }

    @Test
    fun `an unrecognized action writes nothing`() {
        NotificationActionReceiver().onReceive(
            context,
            actionIntent("com.medguard.alarms.action.UNKNOWN", "schedule-1:one"),
        )

        assertTrue(PendingActionStore.readAll(context).isEmpty())
    }

    @Test
    fun `a missing occurrenceKey writes nothing`() {
        NotificationActionReceiver().onReceive(
            context,
            actionIntent(NotificationActionReceiver.ACTION_TAKEN, occurrenceKey = null),
        )

        assertTrue(PendingActionStore.readAll(context).isEmpty())
    }

    @Test
    fun `starts the headless service when no JS runtime is alive`() {
        NotificationActionReceiver().onReceive(
            context,
            actionIntent(NotificationActionReceiver.ACTION_TAKEN, "schedule-1:one"),
        )

        val first = shadowOf(application).nextStartedService
        val second = shadowOf(application).nextStartedService
        val startedClassNames = listOfNotNull(first?.component?.className, second?.component?.className)

        assertTrue(startedClassNames.contains(MedGuardHeadlessService::class.java.name))
    }

    @Test
    fun `always tells DoseAlarmService to stop the chime, whichever action was tapped`() {
        NotificationActionReceiver().onReceive(
            context,
            actionIntent(NotificationActionReceiver.ACTION_SNOOZE, "schedule-1:one"),
        )

        val first = shadowOf(application).nextStartedService
        val second = shadowOf(application).nextStartedService
        val stopChime = listOfNotNull(first, second).find {
            it.component?.className == DoseAlarmService::class.java.name
        }

        assertEquals(DoseAlarmService.ACTION_STOP_CHIME, stopChime?.action)
    }

    @Test
    fun `cancels the notification when a real notification id is provided`() {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        MedGuardChannels.createAll(context)
        manager.notify(
            42,
            Notification.Builder(context, MedGuardChannels.DOSE_STANDARD)
                .setSmallIcon(android.R.drawable.ic_dialog_alert)
                .build(),
        )
        assertEquals(1, manager.activeNotifications.size)

        NotificationActionReceiver().onReceive(
            context,
            actionIntent(NotificationActionReceiver.ACTION_TAKEN, "schedule-1:one", notificationId = 42),
        )

        assertEquals(0, manager.activeNotifications.size)
    }

    @Test
    fun `does not crash when no notification id is provided`() {
        NotificationActionReceiver().onReceive(
            context,
            actionIntent(NotificationActionReceiver.ACTION_TAKEN, "schedule-1:one"),
        )

        // No assertion beyond "did not throw" — the -1 sentinel default is deliberately a no-op,
        // covering the case a notification was already dismissed before the tap was processed.
    }
}
