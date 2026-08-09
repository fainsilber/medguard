-- Sprint A3 (docs/android-client-plan.md, delta AD5): snooze becomes data.
--
-- Until now a snooze was a `Map` entry in a React component — it vanished on reload, could not be
-- bounded, and above all the server never learned it happened. That last one is why this table
-- exists rather than a client-side field: an escalation can only be stopped by something the
-- Durable Object can see, and `applyBatch` already sees every synced record. Sprint A4's dose
-- chain therefore needs no new channel to learn that a caregiver deferred a dose — it reads this.
--
-- Append-only, like `intake_logs` and `inventory_adjustments` and for the same reason: two
-- caregivers snoozing the same dose while offline must both survive the merge. Last-write-wins
-- would silently discard one, and "the bound is three snoozes" would then be counting rows that
-- another device had already overwritten. Deduplicated by the client-generated id, which is what
-- makes a sync retry idempotent — the difference between a resent request and a second snooze.
--
-- The shape mirrors `inventory_adjustments` exactly: household-scoped, `seq`-ordered, `payload`
-- carrying the whole zod-validated record, and the queryable fields lifted into real columns so
-- A4's alarm chain can reason about deferrals in SQL rather than by parsing JSON per row.
CREATE TABLE dose_snoozes (
  id                      TEXT NOT NULL,
  household_id            TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  seq                     INTEGER NOT NULL,
  -- An `occurrenceKey` (`${scheduleId}:${dueAt}`), not a foreign key: an occurrence is derived
  -- from a schedule by expansion, so it has no row of its own to reference.
  occurrence_id           TEXT NOT NULL,
  minutes                 INTEGER NOT NULL,
  count                   INTEGER NOT NULL,
  created_at              TEXT NOT NULL,
  created_by_user_id      TEXT NOT NULL,
  created_by_device_id    TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  updated_by_device_id    TEXT NOT NULL,
  payload                 TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);

CREATE INDEX idx_dose_snoozes_seq ON dose_snoozes(household_id, seq);

-- The query A4's escalation check runs per occurrence: "has anyone deferred this dose, and how
-- many times?" Without this index it is a full scan of every snooze the household has ever made.
CREATE INDEX idx_dose_snoozes_occurrence ON dose_snoozes(household_id, occurrence_id);

UPDATE schema_meta SET value = '3' WHERE key = 'schema_version';
