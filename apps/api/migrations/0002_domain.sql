-- Sprint 3: the real domain schema — households, identity, and the synced record tables.
--
-- Two conventions run through every table here, and both exist for safety reasons:
--
--   1. **Every domain row carries `household_id`, and every query filters on it.** This is the
--      boundary that keeps one family's medical data away from another's. It is enforced in the
--      repository layer rather than trusted to callers, and tested as an explicit negative case.
--
--   2. **Every domain row carries `seq`, a per-household monotonically increasing integer.**
--      This is the sync cursor. Timestamps cannot serve this purpose: two devices can write the
--      same millisecond, and a device with a wrong clock would otherwise be able to write a row
--      that a puller has already scanned past and will never see again — a silently lost dose.
--      `seq` is assigned by the server from `households.change_seq`, never by a client.
--
-- Each domain table also stores `payload` — the complete, zod-validated client record as JSON —
-- alongside the columns the server itself queries. The columns exist so the Worker and Durable
-- Object can reason about doses in SQL (Sprint 4's authoritative cooldown re-check, Sprint 5's
-- alarm scheduling); the payload exists so a record round-trips back to the client without the
-- SQL mapping being able to silently drop a field it forgot about.

-- ---------------------------------------------------------------------------
-- Households and identity
-- ---------------------------------------------------------------------------

CREATE TABLE households (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  -- The sync cursor source. Bumped inside the same transaction as every accepted write.
  change_seq    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_users_household ON users(household_id);

CREATE TABLE devices (
  id                TEXT PRIMARY KEY,
  household_id      TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 of the bearer token, never the token itself: a leaked database backup must not hand
  -- someone a working credential to a child's medical record.
  token_hash        TEXT NOT NULL UNIQUE,
  -- Delta D8 — a native Android client registers against this same backend with FCM credentials
  -- instead of a Web Push subscription, and must not need a migration to do it.
  push_provider     TEXT NOT NULL DEFAULT 'webpush' CHECK (push_provider IN ('webpush', 'fcm')),
  push_credentials  TEXT,
  platform          TEXT,
  created_at        TEXT NOT NULL,
  last_seen_at      TEXT
);

CREATE INDEX idx_devices_household ON devices(household_id);

-- ---------------------------------------------------------------------------
-- Join codes
-- ---------------------------------------------------------------------------

-- A 6-digit code is only a million possibilities, so it is defended three ways at once: it is
-- short-lived, it is single-use, and redemption attempts are rate limited (see join_attempts).
-- Any one of those alone is not enough.
CREATE TABLE join_codes (
  -- SHA-256 of the code. Looked up by hash, so the plaintext exists only in the issuing response
  -- and in the caregiver's hands.
  code_hash          TEXT PRIMARY KEY,
  household_id       TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL,
  expires_at         TEXT NOT NULL,
  -- Set on redemption. Single-use is enforced by requiring this to be NULL, so a replayed code
  -- cannot mint a second device token.
  redeemed_at        TEXT,
  redeemed_by_device TEXT
);

CREATE INDEX idx_join_codes_household ON join_codes(household_id);

-- Rolling-window rate limiting for redemption. Keyed by client IP: an attacker enumerating codes
-- has to come from somewhere, and without this a million guesses is a few minutes of scripting.
CREATE TABLE join_attempts (
  source        TEXT NOT NULL,
  attempted_at  TEXT NOT NULL
);

CREATE INDEX idx_join_attempts_source ON join_attempts(source, attempted_at);

-- ---------------------------------------------------------------------------
-- Synced domain records
-- ---------------------------------------------------------------------------

-- Every table below shares the same six sync columns — household_id, id, seq, updated_at,
-- updated_by_device_id, payload — so the merge, cursor and deduplication rules can be written
-- once and applied uniformly. Seven hand-written copies of subtle merge logic is exactly how one
-- of them ends up subtly different, and a lost dose is the consequence.
--
-- On the append-only tables (intake_logs, inventory_adjustments) updated_at/updated_by_device_id
-- record when the row was created and by which device; nothing ever overwrites them.

-- `id` is always the literal 'household' client-side. Kept as a column anyway rather than making
-- household_id the sole key, so this table has the same shape as every other.
CREATE TABLE household_settings (
  id                      TEXT NOT NULL,
  household_id            TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  seq                     INTEGER NOT NULL,
  time_zone               TEXT NOT NULL,
  escalation_after_mins   INTEGER NOT NULL,
  snooze_mins             INTEGER NOT NULL,
  updated_at              TEXT NOT NULL,
  updated_by_device_id    TEXT NOT NULL,
  payload                 TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);

CREATE INDEX idx_household_settings_seq ON household_settings(household_id, seq);

CREATE TABLE medicines (
  id                      TEXT NOT NULL,
  household_id            TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  seq                     INTEGER NOT NULL,
  patient_id              TEXT NOT NULL,
  name                    TEXT NOT NULL,
  as_needed               INTEGER NOT NULL DEFAULT 0,
  -- Nullable: absent means no cooldown / no cap configured. Read directly by the Sprint 4
  -- authoritative safety re-check, which is why these are columns and not only JSON.
  min_hours_between_doses REAL,
  max_daily_doses         INTEGER,
  archived                INTEGER NOT NULL DEFAULT 0,
  updated_at              TEXT NOT NULL,
  updated_by_device_id    TEXT NOT NULL,
  payload                 TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);

CREATE INDEX idx_medicines_seq ON medicines(household_id, seq);

CREATE TABLE schedules (
  id                      TEXT NOT NULL,
  household_id            TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  seq                     INTEGER NOT NULL,
  medicine_id             TEXT NOT NULL,
  patient_id              TEXT NOT NULL,
  active                  INTEGER NOT NULL DEFAULT 1,
  start_date              TEXT NOT NULL,
  end_date                TEXT,
  updated_at              TEXT NOT NULL,
  updated_by_device_id    TEXT NOT NULL,
  payload                 TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);

CREATE INDEX idx_schedules_seq ON schedules(household_id, seq);
CREATE INDEX idx_schedules_medicine ON schedules(household_id, medicine_id);

-- Append-only (safety invariant 1). A correction inserts a new row naming the one it replaces via
-- supersedes_id; nothing ever updates or deletes an existing log.
CREATE TABLE intake_logs (
  id                      TEXT NOT NULL,
  household_id            TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  seq                     INTEGER NOT NULL,
  patient_id              TEXT NOT NULL,
  medicine_id             TEXT NOT NULL,
  schedule_id             TEXT,
  type                    TEXT NOT NULL,
  status                  TEXT NOT NULL,
  scheduled_time          TEXT,
  -- When the dose was actually given. This is what cooldown and rolling-cap arithmetic use, so it
  -- is indexed alongside medicine_id for the Sprint 4 re-check.
  actual_time             TEXT NOT NULL,
  quantity_taken          REAL NOT NULL,
  logged_by_user_id       TEXT NOT NULL,
  logged_by_device_id     TEXT NOT NULL,
  supersedes_id           TEXT,
  -- Non-null only when a caregiver deliberately overrode a safety block. Kept as a column so an
  -- audit of overrides is a query, not a JSON scan.
  override_reason         TEXT,
  override_blocked_by     TEXT,
  override_confirmed_by   TEXT,
  updated_at              TEXT NOT NULL,
  updated_by_device_id    TEXT NOT NULL,
  payload                 TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);

CREATE INDEX idx_intake_logs_seq ON intake_logs(household_id, seq);
CREATE INDEX idx_intake_logs_medicine_time ON intake_logs(household_id, medicine_id, actual_time);
CREATE INDEX idx_intake_logs_supersedes ON intake_logs(household_id, supersedes_id);

CREATE TABLE inventory_items (
  id                      TEXT NOT NULL,
  household_id            TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  seq                     INTEGER NOT NULL,
  medicine_id             TEXT NOT NULL,
  refill_threshold        REAL NOT NULL,
  unit_name               TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  updated_by_device_id    TEXT NOT NULL,
  payload                 TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);

CREATE INDEX idx_inventory_items_seq ON inventory_items(household_id, seq);

-- Append-only ledger, not a mutable counter (delta D3). Stock is the sum of these deltas, so two
-- caregivers decrementing offline both land instead of one silently overwriting the other.
-- Deduplicated by the client-generated id, which is what makes a sync retry idempotent.
CREATE TABLE inventory_adjustments (
  id                      TEXT NOT NULL,
  household_id            TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  seq                     INTEGER NOT NULL,
  medicine_id             TEXT NOT NULL,
  delta                   REAL NOT NULL,
  reason                  TEXT NOT NULL,
  related_log_id          TEXT,
  created_at              TEXT NOT NULL,
  created_by_user_id      TEXT NOT NULL,
  created_by_device_id    TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  updated_by_device_id    TEXT NOT NULL,
  payload                 TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);

CREATE INDEX idx_inventory_adjustments_seq ON inventory_adjustments(household_id, seq);
CREATE INDEX idx_inventory_adjustments_medicine ON inventory_adjustments(household_id, medicine_id);

CREATE TABLE shabbat_config (
  id                      TEXT NOT NULL,
  household_id            TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  seq                     INTEGER NOT NULL,
  patient_id              TEXT NOT NULL,
  auto_shabbat_enabled    INTEGER NOT NULL DEFAULT 0,
  latitude                REAL NOT NULL,
  longitude               REAL NOT NULL,
  israel_holidays         INTEGER NOT NULL DEFAULT 1,
  updated_at              TEXT NOT NULL,
  updated_by_device_id    TEXT NOT NULL,
  payload                 TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);

CREATE INDEX idx_shabbat_config_seq ON shabbat_config(household_id, seq);

UPDATE schema_meta SET value = '2' WHERE key = 'schema_version';
