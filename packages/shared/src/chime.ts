import {
  DEFAULT_SHABBAT_CHIME_DURATION_SECONDS,
  DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS,
  MAX_CHIME_DURATION_SECONDS,
  MIN_CHIME_DURATION_SECONDS,
} from './settings.js';
import type { ShabbatConfig } from './types.js';

/**
 * How long a dose alert rings, in one place.
 *
 * Two things need this answer and must never disagree about it: the Android alarm horizon, which
 * bakes the length into the payload an alarm fires with (possibly days later, possibly with the
 * app process dead), and any surface that wants to *show* a caregiver what the alert will do. A
 * second copy of "weekday or Shabbat, and what if it isn't set" is how the two drift apart.
 *
 * The mode is passed in rather than derived here, because the caller already knows it from
 * `shabbatModeAt` — and on Android that decision is deliberately made from the instant the alarm
 * will *fire*, not from now, so a dose armed on Friday afternoon for after candle lighting already
 * carries the Shabbat length.
 */
export interface ChimeDurationInput {
  /** From `shabbatModeAt(...)`, evaluated at the instant the alarm fires. */
  inShabbat: boolean;
  /**
   * Absent means a device that has never synced one, which takes the defaults — the same answer
   * the Durable Object gives from the same inputs.
   */
  shabbatConfig?: ShabbatConfig | undefined;
}

/**
 * Clamped, always. A settings screen is validated, but a synced record written by an older client,
 * a hand-edited export, or a bug elsewhere is not — and the failure this guards against is not
 * hypothetical: the Shabbat this was written for had phones ringing for hours. The floor exists
 * for the opposite reason, so an alert can never be too short to notice.
 */
function clamp(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS;
  }
  return Math.min(
    MAX_CHIME_DURATION_SECONDS,
    Math.max(MIN_CHIME_DURATION_SECONDS, Math.round(seconds)),
  );
}

export function chimeDurationSecondsFor(input: ChimeDurationInput): number {
  const { inShabbat, shabbatConfig } = input;

  if (inShabbat) {
    return clamp(shabbatConfig?.chimeDurationSeconds ?? DEFAULT_SHABBAT_CHIME_DURATION_SECONDS);
  }

  // `weekdayChimeDurationSeconds` was added after `chimeDurationSeconds`, so every household that
  // existed before this change has a config with only the latter. Falling back to the default
  // rather than to the Shabbat value is deliberate: the old single field meant "Shabbat chime" in
  // the PRD even though the code read it for weekdays too, and inheriting 30 seconds onto weekdays
  // would silently shorten the alert that a caregiver is actually expected to act on.
  return clamp(
    shabbatConfig?.weekdayChimeDurationSeconds ?? DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS,
  );
}
