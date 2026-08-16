package com.medguard.alarms

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Invariant 7 in Kotlin: a caregiver's tap must never be lost, whichever side of the process the
 * crash lands on. The class's own doc comment names the incident this replaced — an earlier
 * destructive read-and-clear meant a process killed between the read and the resulting
 * `IntakeLog` write lost the tap with no record anywhere it had happened. Read and ack are
 * separate operations specifically so that can't recur: JS acks only after the dose has actually
 * committed, so a crash mid-apply costs a repeated read, never a lost one.
 */
@RunWith(RobolectricTestRunner::class)
class PendingActionStoreTest {
    private val context: Context = ApplicationProvider.getApplicationContext()

    @Before
    fun clearStore() {
        PendingActionStore.ack(context, PendingActionStore.readAll(context).map { it.id })
    }

    @Test
    fun `is empty before anything is captured`() {
        assertTrue(PendingActionStore.readAll(context).isEmpty())
    }

    @Test
    fun `add then readAll returns the entry with a derived id`() {
        PendingActionStore.add(context, "schedule-1:one", "taken", 1_000L)

        val entries = PendingActionStore.readAll(context)

        assertEquals(1, entries.size)
        val entry = entries.single()
        assertEquals("schedule-1:one", entry.occurrenceKey)
        assertEquals("taken", entry.action)
        assertEquals(1_000L, entry.tappedAtMs)
        assertEquals("schedule-1:one|taken|1000", entry.id)
    }

    @Test
    fun `readAll is non-destructive — reading twice returns the same entries`() {
        PendingActionStore.add(context, "schedule-1:one", "taken", 1_000L)

        val first = PendingActionStore.readAll(context)
        val second = PendingActionStore.readAll(context)

        assertEquals(first, second)
        assertEquals(1, second.size)
    }

    @Test
    fun `ack removes only the named ids, leaving the rest`() {
        PendingActionStore.add(context, "schedule-1:one", "taken", 1_000L)
        PendingActionStore.add(context, "schedule-1:two", "taken", 2_000L)
        val idToAck = PendingActionStore.readAll(context).first { it.occurrenceKey == "schedule-1:one" }.id

        PendingActionStore.ack(context, listOf(idToAck))

        assertEquals(
            listOf("schedule-1:two"),
            PendingActionStore.readAll(context).map { it.occurrenceKey },
        )
    }

    @Test
    fun `ack with no ids is a no-op`() {
        PendingActionStore.add(context, "schedule-1:one", "taken", 1_000L)

        PendingActionStore.ack(context, emptyList())

        assertEquals(1, PendingActionStore.readAll(context).size)
    }

    @Test
    fun `a tap landing between a read and its ack survives`() {
        // The exact race invariant 7 protects against: JS reads the pending actions, and before
        // it acks what it applied, a *new* tap lands (a second notification action broadcast
        // arriving while the first drain is still in flight). Acking only the ids from the first
        // read must not drop the one that arrived in between.
        PendingActionStore.add(context, "schedule-1:one", "taken", 1_000L)
        val firstRead = PendingActionStore.readAll(context)

        PendingActionStore.add(context, "schedule-1:two", "taken", 2_000L)
        PendingActionStore.ack(context, firstRead.map { it.id })

        assertEquals(
            listOf("schedule-1:two"),
            PendingActionStore.readAll(context).map { it.occurrenceKey },
        )
    }

    @Test
    fun `tolerates an entry written by a pre-A3 build, which had no id field`() {
        val store = context.getSharedPreferences("medguard_pending_actions", Context.MODE_PRIVATE)
        val legacyEntry =
            JSONObject()
                .put("occurrenceKey", "schedule-1:legacy")
                .put("action", "taken")
                .put("tappedAtMs", 3_000L)
        store.edit().putString("entries", JSONArray().put(legacyEntry).toString()).commit()

        val entries = PendingActionStore.readAll(context)

        assertEquals(1, entries.size)
        // The same derivation `add()` uses for a real id, so the pre-A3 entry can still be acked
        // by the id readAll() hands back for it.
        assertEquals("schedule-1:legacy|taken|3000", entries.single().id)
    }

    @Test
    fun `a pre-A3 entry can be acked using its derived id`() {
        val store = context.getSharedPreferences("medguard_pending_actions", Context.MODE_PRIVATE)
        val legacyEntry =
            JSONObject()
                .put("occurrenceKey", "schedule-1:legacy")
                .put("action", "taken")
                .put("tappedAtMs", 3_000L)
        store.edit().putString("entries", JSONArray().put(legacyEntry).toString()).commit()
        val derivedId = PendingActionStore.readAll(context).single().id

        PendingActionStore.ack(context, listOf(derivedId))

        assertTrue(PendingActionStore.readAll(context).isEmpty())
    }
}
