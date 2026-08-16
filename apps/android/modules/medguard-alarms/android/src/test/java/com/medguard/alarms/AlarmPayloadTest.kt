package com.medguard.alarms

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * `AlarmPayload` is what a fired alarm posts its own notification and chime from, with no JS
 * process required to be running — the JSON round trip here is what actually crosses that
 * boundary (`AlarmScheduler` writes it into a `PendingIntent` extra; `AlarmReceiver` reads it back
 * on the other side of a process that may not have been alive a moment before). Also proves the
 * failure mode `ArmedAlarmStore.getAll()`'s `runCatching { AlarmPayload.fromJson(...) }` exists to
 * guard against: a malformed or partial entry throws rather than silently returning a payload with
 * missing fields.
 *
 * Robolectric, not plain JUnit: `org.json.JSONObject` on the plain Android JVM unit-test classpath
 * is a stub that throws "not mocked" — Robolectric's shadow is what makes it work.
 */
@RunWith(RobolectricTestRunner::class)
class AlarmPayloadTest {
    private fun samplePayload() =
        AlarmPayload(
            occurrenceKey = "schedule-1:2026-06-15T09:00:00.000Z",
            channelId = "dose_standard_v1",
            title = "Ondansetron is due",
            body = "4mg",
            chimeDurationSeconds = 45,
            escalation = false,
            triggerAtMs = 1_781_000_000_000L,
        )

    @Test
    fun `round-trips every field through JSON`() {
        val payload = samplePayload()

        val restored = AlarmPayload.fromJson(payload.toJson())

        assertEquals(payload, restored)
    }

    @Test
    fun `round-trips an escalation payload`() {
        val payload = samplePayload().copy(channelId = "dose_escalation_v1", escalation = true)

        assertEquals(payload, AlarmPayload.fromJson(payload.toJson()))
    }

    @Test
    fun `throws rather than returning a partial payload when a field is missing`() {
        // The exact failure ArmedAlarmStore.getAll()'s runCatching exists to catch — a corrupt or
        // pre-migration SharedPreferences entry must not silently arm an alarm with garbage
        // fields, it must be dropped outright.
        val incomplete = samplePayload().toJson().apply { remove("triggerAtMs") }

        assertThrows(org.json.JSONException::class.java) { AlarmPayload.fromJson(incomplete) }
    }

    @Test
    fun `throws on a field of the wrong type`() {
        val wrongType = JSONObject(samplePayload().toJson().toString()).put("chimeDurationSeconds", "soon")

        assertThrows(org.json.JSONException::class.java) { AlarmPayload.fromJson(wrongType) }
    }
}
