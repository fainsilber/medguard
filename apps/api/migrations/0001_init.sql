-- Sprint 0: proves the D1 binding and the migration pipeline end to end.
-- The real domain schema (households, users, devices, medicines, schedules, intake_logs,
-- inventory_adjustments) lands in Sprint 3.

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
