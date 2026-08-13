-- Sprint A5 (docs/android-client-plan.md, "A5 — Shabbat on native"): the Shabbat windows the
-- whole system reads.
--
-- `shabbat_config` (0002) has been the *inputs* since Sprint 1 — coordinates, candle-lighting
-- offset, Havdalah rule, Israel/diaspora. This table holds the *output*: the actual periods
-- during which the app is in Shabbat mode, computed once in the Worker with @hebcal/core (PRD §3)
-- and published to every device like any other synced record.
--
-- Why store them rather than have each device compute its own: three surfaces need the same
-- answer — the Durable Object deciding whether to escalate, the phone deciding which notification
-- channel to arm, and the screen showing eight weeks of times to be checked against a luach — and
-- two of the three must work with no network. Computing in three places means three chances to
-- disagree about whether it is Shabbat; syncing the answer means the phone and the server are
-- wrong together or right together, and the verification screen shows exactly what the server
-- will act on.
--
-- Server-authored, unlike every other table here: `routes/sync.ts` rejects a client push to it.
-- A device that could mint its own windows could talk itself out of Shabbat mode.
--
-- Last-write-wins rather than append-only: republishing a window (the config changed, or the
-- rolling horizon moved) must overwrite it, and the deterministic `shabbat:<startsAt>` id is what
-- makes that an update rather than a duplicate.
CREATE TABLE shabbat_windows (
  id                      TEXT NOT NULL,
  household_id            TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  seq                     INTEGER NOT NULL,
  patient_id              TEXT NOT NULL,
  -- Candle lighting and Havdalah as instants. Lifted out of the payload into real columns so the
  -- alarm chain can ask "is now inside a window?" in SQL, on every wake, without parsing JSON.
  starts_at               TEXT NOT NULL,
  ends_at                 TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  updated_by_device_id    TEXT NOT NULL,
  payload                 TEXT NOT NULL,
  PRIMARY KEY (household_id, id)
);

CREATE INDEX idx_shabbat_windows_seq ON shabbat_windows(household_id, seq);

-- The mode check, run on every alarm wake: the window covering an instant, if any.
CREATE INDEX idx_shabbat_windows_span ON shabbat_windows(household_id, starts_at, ends_at);

UPDATE schema_meta SET value = '4' WHERE key = 'schema_version';
