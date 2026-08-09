/**
 * First-run defaults for `HouseholdSettings`.
 *
 * Shared rather than duplicated per client: these were private constants in each app's
 * `useHouseholdSettings.ts`, which meant the web and Android apps could bootstrap a household
 * with different escalation and snooze windows depending on which client happened to create it —
 * a household-wide safety setting decided by an implementation detail of one device.
 *
 * These are bootstrapping values only. Once a household exists, the stored settings are
 * authoritative and changing a default here does not move an existing household.
 */

/** PRD §4: an unacknowledged scheduled dose escalates to the other caregivers after this long. */
export const DEFAULT_ESCALATION_MINUTES = 15;

/**
 * 20, not the PRD's original 15, per the signed-off decision in `docs/android-client-plan.md`:
 * `MAX_SNOOZE_COUNT` (3) snoozes at 20 minutes is a 60-minute total deferral, matching the width
 * of AD6's escalation window exactly.
 */
export const DEFAULT_SNOOZE_MINUTES = 20;
