package com.medguard.alarms

import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * A channel's sound and importance are immutable after creation (the class's own doc comment) —
 * without versioned ids, retuning the chime the way the web Shabbat burst was retuned four times
 * would require every caregiver to reinstall the app. This is the one place that regression is
 * unfixable in the field without a reinstall, so it is worth pinning exactly: the five ids exist,
 * the two dose channels are `IMPORTANCE_HIGH` (nothing routes an alert about a due medicine
 * through a channel the OS is allowed to silence), and escalation alone bypasses Do Not Disturb.
 */
@RunWith(RobolectricTestRunner::class)
class MedGuardChannelsTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val manager
        get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    @Test
    fun `creates all five versioned channels`() {
        MedGuardChannels.createAll(context)

        for (id in listOf(
            MedGuardChannels.DOSE_STANDARD,
            MedGuardChannels.DOSE_ESCALATION,
            MedGuardChannels.SHABBAT,
            MedGuardChannels.LOW_STOCK,
            MedGuardChannels.SYNC_STATUS,
        )) {
            assertNotNull("expected channel $id to exist", manager.getNotificationChannel(id))
        }
    }

    @Test
    fun `both dose channels are high importance, so the OS cannot silently downgrade them`() {
        MedGuardChannels.createAll(context)

        assertEquals(
            NotificationManager.IMPORTANCE_HIGH,
            manager.getNotificationChannel(MedGuardChannels.DOSE_STANDARD).importance,
        )
        assertEquals(
            NotificationManager.IMPORTANCE_HIGH,
            manager.getNotificationChannel(MedGuardChannels.DOSE_ESCALATION).importance,
        )
    }

    @Test
    fun `only the escalation channel bypasses Do Not Disturb`() {
        MedGuardChannels.createAll(context)

        assertTrue(manager.getNotificationChannel(MedGuardChannels.DOSE_ESCALATION).canBypassDnd())
        assertFalse(manager.getNotificationChannel(MedGuardChannels.DOSE_STANDARD).canBypassDnd())
        assertFalse(manager.getNotificationChannel(MedGuardChannels.SHABBAT).canBypassDnd())
    }

    @Test
    fun `low stock and sync status are deliberately lower importance than a dose alert`() {
        MedGuardChannels.createAll(context)

        assertEquals(
            NotificationManager.IMPORTANCE_DEFAULT,
            manager.getNotificationChannel(MedGuardChannels.LOW_STOCK).importance,
        )
        assertEquals(
            NotificationManager.IMPORTANCE_LOW,
            manager.getNotificationChannel(MedGuardChannels.SYNC_STATUS).importance,
        )
    }

    @Test
    fun `calling createAll again is safe — channels are not duplicated or reset`() {
        MedGuardChannels.createAll(context)
        MedGuardChannels.createAll(context)

        assertEquals(5, manager.notificationChannels.size)
    }
}
