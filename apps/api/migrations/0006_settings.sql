-- How many times a caregiver may snooze one scheduled dose before escalation takes over,
-- configurable per household rather than the fixed `MAX_SNOOZE_COUNT` (3) every household
-- previously shared (packages/shared/src/snooze.ts).
--
-- Nullable like medicines.min_hours_between_doses / max_daily_doses: absent means "use
-- packages/shared's default", not zero, and every household that synced before this setting
-- existed has no value for it yet. `HouseholdDO.snoozeLimitReached` resolves the default and
-- clamp through `resolveMaxSnoozeCount()` the same way the client does.
ALTER TABLE household_settings ADD COLUMN max_snooze_count INTEGER;

UPDATE schema_meta SET value = '6' WHERE key = 'schema_version';
