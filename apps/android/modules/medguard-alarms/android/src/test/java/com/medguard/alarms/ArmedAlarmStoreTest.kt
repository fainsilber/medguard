package com.medguard.alarms

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The local mirror of "what's currently armed" — `BootReceiver`'s only source of what to re-arm
 * after a reboot, since alarms do not survive one. A household that reboots and quietly stops
 * getting dose alarms is the worst failure this app can have, so the two properties that matter
 * here are: a write actually persists (`SharedPreferences.commit()`, not `apply()`), and one
 * corrupt entry never takes the rest of the armed list down with it.
 */
@RunWith(RobolectricTestRunner::class)
class ArmedAlarmStoreTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun payload(occurrenceKey: String, triggerAtMs: Long = 1_781_000_000_000L) =
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
    fun `is empty before anything is armed`() {
        assertTrue(ArmedAlarmStore.getAll(context).isEmpty())
    }

    @Test
    fun `put stores a payload retrievable by getAll`() {
        val entry = payload("schedule-1:2026-06-15T09:00:00.000Z")

        ArmedAlarmStore.put(context, entry)

        assertEquals(listOf(entry), ArmedAlarmStore.getAll(context))
    }

    @Test
    fun `put replaces an existing entry for the same occurrenceKey rather than duplicating it`() {
        val key = "schedule-1:2026-06-15T09:00:00.000Z"
        ArmedAlarmStore.put(context, payload(key, triggerAtMs = 1_000L))

        ArmedAlarmStore.put(context, payload(key, triggerAtMs = 2_000L))

        val all = ArmedAlarmStore.getAll(context)
        assertEquals(1, all.size)
        assertEquals(2_000L, all.single().triggerAtMs)
    }

    @Test
    fun `remove drops exactly the named occurrence`() {
        ArmedAlarmStore.put(context, payload("schedule-1:one"))
        ArmedAlarmStore.put(context, payload("schedule-1:two"))

        ArmedAlarmStore.remove(context, "schedule-1:one")

        assertEquals(listOf("schedule-1:two"), ArmedAlarmStore.getAll(context).map { it.occurrenceKey })
    }

    @Test
    fun `removing an occurrence that was never armed changes nothing`() {
        ArmedAlarmStore.put(context, payload("schedule-1:one"))

        ArmedAlarmStore.remove(context, "schedule-1:never-armed")

        assertEquals(listOf("schedule-1:one"), ArmedAlarmStore.getAll(context).map { it.occurrenceKey })
    }

    @Test
    fun `a corrupt entry is skipped rather than failing the whole read`() {
        // Simulates a SharedPreferences entry that isn't valid AlarmPayload JSON at all — the
        // exact case AlarmPayload.fromJson()'s callers must tolerate, since a single bad entry
        // (a pre-migration build, a partial write interrupted by a crash) must not make
        // BootReceiver drop every other armed alarm along with it.
        ArmedAlarmStore.put(context, payload("schedule-1:good"))
        context
            .getSharedPreferences("medguard_armed_alarms", Context.MODE_PRIVATE)
            .edit()
            .putString("schedule-1:corrupt", "not valid json")
            .commit()

        val all = ArmedAlarmStore.getAll(context)

        assertEquals(listOf("schedule-1:good"), all.map { it.occurrenceKey })
    }
}
