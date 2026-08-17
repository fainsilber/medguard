package com.medguard.alarms

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Where the FCM token lands when `onNewToken` fires with the app process dead — a rotation that
 * never gets written down here is a device that silently stops being reachable by the push
 * backstop until something else happens to trigger re-registration.
 */
@RunWith(RobolectricTestRunner::class)
class PushTokenStoreTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun `is absent before a token has ever been saved`() {
        assertNull(PushTokenStore.read(context))
    }

    @Test
    fun `round-trips a saved token`() {
        PushTokenStore.save(context, "token-1")

        assertEquals("token-1", PushTokenStore.read(context))
    }

    @Test
    fun `saving a new token replaces the old one`() {
        PushTokenStore.save(context, "token-1")

        PushTokenStore.save(context, "token-2")

        assertEquals("token-2", PushTokenStore.read(context))
    }
}
