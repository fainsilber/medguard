-- Multi-patient households: a household can now track more than one patient, and a medicine can
-- be private to one patient or shared across several.
--
-- Two new tables, both following the same conventions as every synced table since 0002:
-- `household_id` + `seq` for the sync boundary and cursor, `payload` for the round-trippable JSON
-- record, and the LWW columns (`updated_at`, `updated_by_device_id`) since neither is append-only
-- — renaming a patient or reassigning a medicine both overwrite in place.
--
-- `medicines.patient_id` (0002) is left as-is: it becomes vestigial (see the doc comment on
-- `Medicine.patientId` in packages/shared/src/types.ts) rather than dropped, because SQLite cannot
-- relax a `NOT NULL` column without a table rebuild, and there is nothing to gain from one.
--
-- `patients` and `medicine_patients` carry no household-scoped uniqueness beyond their primary
-- key: `medicine_patients.id` is `${medicineId}:${patientId}` (see `medicinePatientId()` in
-- packages/shared/src/types.ts), so re-assigning the same pair converges on the same row instead
-- of duplicating it — the same trick `shabbat_windows.id` uses.

CREATE TABLE patients (
  id                      TEXT NOT NULL,
  household_id            TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  seq                     INTEGER NOT NULL,
  display_name            TEXT NOT NULL,
  archived                INTEGER NOT NULL DEFAULT 0,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  updated_at              TEXT NOT NULL,
  updated_by_device_id    TEXT NOT NULL,
  payload                 TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);

CREATE INDEX idx_patients_seq ON patients(household_id, seq);

-- One row per (medicine, patient) the medicine is assigned to. No row for a pair means that
-- patient does not take that medicine. `active` is a soft-unassign, for the same reason a medicine
-- archives rather than disappears: an intake log written while the assignment existed must still
-- be able to resolve it later, even after a caregiver removes the assignment.
CREATE TABLE medicine_patients (
  id                      TEXT NOT NULL,
  household_id            TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  seq                     INTEGER NOT NULL,
  medicine_id             TEXT NOT NULL,
  patient_id              TEXT NOT NULL,
  active                  INTEGER NOT NULL DEFAULT 1,
  updated_at              TEXT NOT NULL,
  updated_by_device_id    TEXT NOT NULL,
  payload                 TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);

CREATE INDEX idx_medicine_patients_seq ON medicine_patients(household_id, seq);
CREATE INDEX idx_medicine_patients_medicine ON medicine_patients(household_id, medicine_id);
CREATE INDEX idx_medicine_patients_patient ON medicine_patients(household_id, patient_id);

-- The authoritative PRN safety re-check (`HouseholdDO.checkDoseSafety`) now filters by patient as
-- well as medicine, so a shared medicine's cooldown/cap is counted per patient rather than pooled
-- across everyone who takes it. Without this index that query is a full per-household table scan
-- of the intake history — the same table `idx_intake_logs_medicine_time` already exists for.
CREATE INDEX idx_intake_logs_patient_medicine_time
  ON intake_logs(household_id, patient_id, medicine_id, actual_time);

-- ---------------------------------------------------------------------------
-- Backfill: every household that already has a medicine gets one patient, matching the id every
-- pre-multi-patient record was implicitly written against (`SINGLE_PATIENT_ID` in
-- packages/shared/src/types.ts), and one medicine_patients row per existing medicine assigning it
-- to that patient. A caregiver renames the patient on first use; nothing else changes.
--
-- Deterministic ids make this idempotent: re-running it (or a device racing the backfill with its
-- own first sync) converges on the same rows rather than duplicating them.
-- ---------------------------------------------------------------------------

-- Reserve one seq per household that needs a backfilled patient row.
UPDATE households
SET change_seq = change_seq + 1
WHERE id IN (SELECT DISTINCT household_id FROM medicines)
  AND id NOT IN (SELECT household_id FROM patients WHERE id = '00000000-0000-4000-8000-000000000001');

INSERT INTO patients (id, household_id, seq, display_name, archived, sort_order, updated_at, updated_by_device_id, payload)
SELECT
  '00000000-0000-4000-8000-000000000001',
  h.id,
  h.change_seq,
  'Patient',
  0,
  0,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'server-backfill',
  json_object(
    'id', '00000000-0000-4000-8000-000000000001',
    'displayName', 'Patient',
    'archived', json('false'),
    'sortOrder', 0,
    'updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'updatedByDeviceId', 'server-backfill',
    'syncStatus', 'synced'
  )
FROM households h
WHERE h.id IN (SELECT DISTINCT household_id FROM medicines)
  AND h.id NOT IN (SELECT household_id FROM patients WHERE id = '00000000-0000-4000-8000-000000000001');

-- Reserve one seq per not-yet-assigned medicine, for its medicine_patients row.
UPDATE households
SET change_seq = change_seq + (
  SELECT COUNT(*)
  FROM medicines m
  WHERE m.household_id = households.id
    AND (m.household_id || ':' || m.id) NOT IN (
      SELECT mp.household_id || ':' || mp.medicine_id FROM medicine_patients mp
    )
)
WHERE id IN (
  SELECT DISTINCT m.household_id
  FROM medicines m
  WHERE (m.household_id || ':' || m.id) NOT IN (
    SELECT mp.household_id || ':' || mp.medicine_id FROM medicine_patients mp
  )
);

INSERT INTO medicine_patients (id, household_id, seq, medicine_id, patient_id, active, updated_at, updated_by_device_id, payload)
SELECT
  m.id || ':' || '00000000-0000-4000-8000-000000000001',
  m.household_id,
  h.change_seq - reserved.n + ROW_NUMBER() OVER (PARTITION BY m.household_id ORDER BY m.id),
  m.id,
  '00000000-0000-4000-8000-000000000001',
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'server-backfill',
  json_object(
    'id', m.id || ':' || '00000000-0000-4000-8000-000000000001',
    'medicineId', m.id,
    'patientId', '00000000-0000-4000-8000-000000000001',
    'active', json('true'),
    'updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    'updatedByDeviceId', 'server-backfill',
    'syncStatus', 'synced'
  )
FROM medicines m
JOIN households h ON h.id = m.household_id
JOIN (
  SELECT m2.household_id, COUNT(*) AS n
  FROM medicines m2
  WHERE (m2.household_id || ':' || m2.id) NOT IN (
    SELECT mp.household_id || ':' || mp.medicine_id FROM medicine_patients mp
  )
  GROUP BY m2.household_id
) reserved ON reserved.household_id = m.household_id
WHERE (m.household_id || ':' || m.id) NOT IN (
  SELECT mp.household_id || ':' || mp.medicine_id FROM medicine_patients mp
);

UPDATE schema_meta SET value = '5' WHERE key = 'schema_version';
