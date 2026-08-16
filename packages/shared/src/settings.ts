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
 * When an unlogged scheduled dose stops being "late" and becomes a missed one (delta AD6).
 *
 * Not a household setting: this is the definition of a word that appears in the medical record.
 * `IntakeStatus` has included `'missed'` since Sprint 1 with nothing saying when it applies, so
 * the Durable Object's sweep — the only writer of a missed log — needed one number to mean it.
 * Three hours is comfortably past the point where every escalation and every permitted snooze has
 * been exhausted (`MAX_SNOOZE_COUNT` × `DEFAULT_SNOOZE_MINUTES` = 60 minutes of deferral), so a
 * dose can never be marked missed while a caregiver is still legitimately deferring it.
 *
 * Written as a real, append-only, correctable `IntakeLog` rather than derived in the UI, so that
 * two clients cannot disagree about whether a dose was missed (safety invariant 1).
 */
export const MISSED_AFTER_MINUTES = 180;

/**
 * 20, not the PRD's original 15, per the signed-off decision in `docs/android-client-plan.md`:
 * `MAX_SNOOZE_COUNT` (3) snoozes at 20 minutes is a 60-minute total deferral, matching the width
 * of AD6's escalation window exactly.
 */
export const DEFAULT_SNOOZE_MINUTES = 20;

/**
 * `ShabbatConfig` bootstrap values (Sprint A5), shared for the same reason as the three above: a
 * household's Shabbat times must not depend on which client happened to create the config.
 *
 * The candle-lighting offset is the PRD's 18 minutes, which is the widespread custom but not a
 * universal one — Jerusalem is 40, Haifa 30, and some communities differ again. It is a setting
 * on the Shabbat screen precisely because the default cannot be right for everyone, and the
 * verification screen exists so it gets checked against a luach rather than trusted.
 */
export const DEFAULT_CANDLE_LIGHTING_OFFSET_MINS = 18;

/** Tzeit hakochavim. The alternative form the schema accepts is a fixed `"<n>_mins"`. */
export const DEFAULT_HAVDALAH = '8.5_degrees';

/**
 * How long a dose alert rings before stopping on its own, per mode.
 *
 * These were one number (the PRD's 45 seconds) until a Shabbat where the alerts rang all day: the
 * chime service could be left with an orphaned, un-stoppable `MediaPlayer` when two doses fell on
 * the same minute, and the auto-stop timeout was the only stop path that existed at all. Splitting
 * the number in two came out of the same review, because the two modes want different lengths for
 * different reasons.
 *
 * **Weekday: 60 seconds.** A caregiver can act on the alert — mark the dose, press a button, pick
 * the phone up — so the timeout is the backstop for nobody reaching the phone, and a minute is how
 * long it is worth ringing before giving up and leaving the notification to be found later.
 *
 * **Shabbat: 30 seconds.** Nothing can be tapped and nothing is recorded (delta D5), so the alert
 * is purely informational: it has said everything it has to say well inside half a minute, and
 * every further second is noise in a house that cannot silence it.
 */
export const DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS = 60;

/** See `DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS`. */
export const DEFAULT_SHABBAT_CHIME_DURATION_SECONDS = 30;

/**
 * Bounds every configured chime length is clamped into, on the client *and* again in Kotlin
 * (`ChimeSession`) before a note is played.
 *
 * Belt and braces rather than redundancy: the Shabbat that prompted this had a phone ringing for
 * hours, and the clamp is what makes that impossible to express at all — whatever a settings
 * screen, a stale synced record, or a corrupted alarm payload happens to say, the sound cannot
 * outlive `MAX_CHIME_DURATION_SECONDS`.
 */
export const MIN_CHIME_DURATION_SECONDS = 5;
export const MAX_CHIME_DURATION_SECONDS = 180;
