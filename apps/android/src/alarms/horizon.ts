import {
  MS_PER_HOUR,
  chimeDurationSecondsFor,
  deriveSnoozeState,
  expandSchedules,
  findLogForOccurrence,
  fromIso,
  occurrenceKey,
  parseOccurrenceKey,
  shabbatModeAt,
} from '@medguard/shared';
import type {
  DoseSnooze,
  EpochMs,
  IntakeLog,
  Medicine,
  Occurrence,
  Schedule,
  ShabbatConfig,
  ShabbatWindow,
} from '@medguard/shared';
import type { MedGuardChannelId } from '../../modules/medguard-alarms/src/index.js';

/**
 * Turning synced domain data into the list of alarms this device should have armed.
 *
 * Pure — every input is explicit, including "now" — so the whole decision is testable without a
 * device, a clock, or an `AlarmManager`. Nothing here talks to Android; `AlarmEngine` does that,
 * and does nothing else.
 *
 * This is the piece that makes the native client worth building: the alarms come from data this
 * device already holds, so they fire with no network, in a hospital basement, on a phone that has
 * not seen the server in a day.
 */

/**
 * How far ahead alarms are armed. Matches the server's own rolling window
 * (docs/android-client-plan.md, "Occurrence horizon") so the local alarm and the server push
 * cover the same span and neither has a period the other doesn't.
 *
 * Re-materialization happens on every sync write and every foreground, so this is a ceiling on
 * how stale the armed set can get, not on how often it is refreshed.
 */
export const ALARM_HORIZON_MS = 48 * MS_PER_HOUR;

/**
 * A ceiling on how many alarms are held at once. `setAlarmClock` shows an upcoming-alarm
 * affordance in the system UI per alarm, and a household with many medicines could otherwise arm
 * hundreds across 48 hours. The nearest ones are kept — anything dropped is far enough out that
 * the next reconcile (minutes away, not days) will arm it long before it is due.
 */
export const MAX_ARMED_ALARMS = 64;

export interface PlannedAlarm {
  /** `occurrenceKey` — the notification tag, and the identity Android arms and cancels by. */
  occurrenceKey: string;
  /** When the alarm should fire: the due time, or a snooze deadline that moved it later. */
  triggerAtMs: EpochMs;
  title: string;
  body: string;
  /**
   * Which channel this dose rings on — the weekday channel, or the Shabbat one for a dose falling
   * inside a published window (Sprint A5). The Shabbat channel posts no action buttons, because
   * tapping one writes a record (delta D5).
   */
  channelId: MedGuardChannelId;
  /**
   * How long the chime plays before auto-stopping, resolved per alarm by
   * `chimeDurationSecondsFor` — the weekday length, or the shorter Shabbat one for a dose falling
   * inside a published window.
   */
  chimeDurationSeconds: number;
  /** Kept so the caller can turn a fired alarm back into a dose without re-expanding. */
  occurrence: Occurrence;
}

export interface MaterializeHorizonInput {
  schedules: readonly Schedule[];
  medicines: readonly Medicine[];
  logs: readonly IntakeLog[];
  snoozes: readonly DoseSnooze[];
  /** The household's fixed zone, never the device's — a caregiver travelling must not shift doses. */
  timeZone: string;
  nowMs: EpochMs;
  horizonMs?: number;
  /**
   * The server-published Shabbat windows this device holds, and the config that governs whether
   * they apply (Sprint A5).
   *
   * Absent means weekday behaviour for everything — which is what a device that has never synced
   * a config should do, and is the same answer the Durable Object gives from the same inputs.
   */
  shabbatWindows?: readonly ShabbatWindow[];
  shabbatConfig?: ShabbatConfig | undefined;
}

function describeDose(
  medicine: Medicine | undefined,
  occurrence: Occurrence,
): { title: string; body: string } {
  const name = medicine?.name ?? 'Medicine';
  const strength = medicine?.strength ? ` ${medicine.strength}` : '';
  const unit = occurrence.dosageQuantity === 1 ? 'dose' : 'doses';

  return {
    title: `${name}${strength} is due`,
    // The lock screen may be all a caregiver sees at 3am, so the quantity goes in the notification
    // rather than only in the app they would have to unlock to reach.
    body: `${occurrence.dosageQuantity} ${unit} · ${occurrence.scheduledLocalTime}`,
  };
}

/**
 * Every alarm this device should currently have armed, nearest first.
 *
 * An occurrence is armed unless one of these is true:
 *
 * - **it already has a log** — the dose was given, skipped, or corrected, so ringing about it
 *   would be wrong. `findLogForOccurrence` follows correction chains, so a dose corrected to
 *   "skipped" stays silent rather than re-arming.
 * - **its medicine is archived or missing** — the schedule may still expand, but a medicine
 *   nobody gives any more should not wake anyone at 3am.
 * - **its trigger has already passed** — a local alarm never fires late. A stale alarm going off
 *   hours after the fact is confusing rather than helpful, and the server push (which does not
 *   depend on this device having been awake) is what covers a genuinely missed dose.
 */
export function materializeHorizon(input: MaterializeHorizonInput): PlannedAlarm[] {
  const { schedules, medicines, logs, snoozes, timeZone, nowMs, shabbatConfig } = input;
  const horizonMs = input.horizonMs ?? ALARM_HORIZON_MS;
  const shabbatWindows = input.shabbatWindows ?? [];

  const medicinesById = new Map(medicines.map((medicine) => [medicine.id, medicine]));

  // Expansion starts at `nowMs`, so an occurrence whose due time has already passed is never
  // produced in the first place — except where a snooze moves it forward, which is handled below
  // by expanding from the earliest snooze-relevant point rather than by widening the whole range.
  const earliestSnoozedDueMs = snoozes.reduce<EpochMs | undefined>((earliest, snooze) => {
    const parsed = parseOccurrenceKey(snooze.occurrenceId);
    if (parsed === undefined) {
      return earliest;
    }
    const dueMs = fromIso(parsed.dueAt);
    return earliest === undefined || dueMs < earliest ? dueMs : earliest;
  }, undefined);

  const fromMs = earliestSnoozedDueMs === undefined ? nowMs : Math.min(nowMs, earliestSnoozedDueMs);

  const occurrences = expandSchedules(schedules, { fromMs, toMs: nowMs + horizonMs }, timeZone);

  const planned: PlannedAlarm[] = [];

  for (const occurrence of occurrences) {
    const medicine = medicinesById.get(occurrence.medicineId);
    if (!medicine || medicine.archived) {
      continue;
    }
    if (findLogForOccurrence(logs, occurrence) !== undefined) {
      continue;
    }

    const key = occurrenceKey(occurrence);
    const snoozedUntilMs = deriveSnoozeState(snoozes, key).untilMs;
    const triggerAtMs = snoozedUntilMs ?? fromIso(occurrence.dueAt);

    if (triggerAtMs <= nowMs) {
      continue;
    }

    // Decided from when the alarm will *fire*, not from now: an alarm armed on Friday afternoon
    // for a dose due after candle lighting belongs on the Shabbat channel already. Through the
    // same `shabbatModeAt` the Durable Object calls, over the same synced windows, so the phone
    // and the server cannot disagree about which side of the boundary a dose falls on.
    const inShabbat = shabbatModeAt(shabbatConfig, shabbatWindows, triggerAtMs);

    planned.push({
      occurrenceKey: key,
      triggerAtMs,
      occurrence,
      channelId: inShabbat ? 'shabbat_v1' : 'dose_standard_v1',
      // Per alarm, from the same `inShabbat` that picks the channel — the two must agree, because
      // an alert with no buttons to press (Shabbat) and one a caregiver is expected to act on
      // want different lengths, and the length is baked into a payload that may fire days later
      // with no JS process alive to correct it.
      chimeDurationSeconds: chimeDurationSecondsFor({ inShabbat, shabbatConfig }),
      ...describeDose(medicine, occurrence),
    });
  }

  return planned.sort((a, b) => a.triggerAtMs - b.triggerAtMs).slice(0, MAX_ARMED_ALARMS);
}
