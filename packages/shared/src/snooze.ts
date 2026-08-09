import { toIso } from './clock.js';
import type { Clock, EpochMs, IdGenerator } from './clock.js';
import { MS_PER_MINUTE } from './timezone.js';
import type { DeviceId, DoseSnooze, UserId } from './types.js';

/**
 * Turning a set of `DoseSnooze` records into "how much longer is this dose deferred, and may it
 * be deferred again".
 *
 * Pure, and shared rather than reimplemented per client (cross-cutting rule 5): the device arms
 * its local alarm from this, the Today screen buckets the occurrence from this, and — once the
 * Durable Object's dose chain exists — the server decides whether to escalate from the same
 * function. A snooze that stops the alarm on the phone but not the escalation on the server would
 * be worse than no snooze at all.
 */

/**
 * Signed off in `docs/android-client-plan.md`. Three snoozes at the household's
 * `snoozeMinutes` (default 20) is a 60-minute total deferral, which is the width of AD6's
 * escalation window — a caregiver can defer through the whole window but cannot defer past the
 * point where the dose becomes missed.
 */
export const MAX_SNOOZE_COUNT = 3;

export interface SnoozeState {
  /** How many snoozes have been granted for this occurrence. */
  count: number;
  /**
   * When the deferral expires — absent when the occurrence has never been snoozed. Feeds
   * `classifyOccurrence`'s `snoozedUntilMs`, and is what the local alarm is re-armed for.
   */
  untilMs?: EpochMs;
  /** False once the bound is reached; the UI disables the button rather than silently no-op'ing. */
  canSnooze: boolean;
}

/**
 * Deadlines run from when the caregiver tapped, not from when the dose was due — "snooze" means
 * "not now, in twenty minutes", and a dose already an hour overdue would otherwise produce a
 * deadline in the past.
 *
 * The latest `createdAt` wins rather than the largest deadline, so that two caregivers snoozing
 * concurrently resolve to the more recent decision rather than the more generous one.
 */
export function deriveSnoozeState(
  snoozes: readonly DoseSnooze[],
  occurrenceId: string,
): SnoozeState {
  const relevant = snoozes.filter((snooze) => snooze.occurrenceId === occurrenceId);

  if (relevant.length === 0) {
    return { count: 0, canSnooze: true };
  }

  let latest = relevant[0] as DoseSnooze;
  for (const snooze of relevant) {
    if (snooze.createdAt > latest.createdAt) {
      latest = snooze;
    }
  }

  return {
    count: relevant.length,
    untilMs: Date.parse(latest.createdAt) + latest.minutes * MS_PER_MINUTE,
    canSnooze: relevant.length < MAX_SNOOZE_COUNT,
  };
}

export interface SnoozeContext {
  clock: Clock;
  ids: IdGenerator;
  userId: UserId;
  deviceId: DeviceId;
}

/**
 * `priorCount` is the count *before* this snooze, so the record's own `count` is 1-based — the
 * first snooze is `count: 1`. Callers pass `deriveSnoozeState(...).count`.
 *
 * `atMs` exists for the one caller that must not use the current instant: a notification action
 * tapped on a lock screen is applied later, sometimes much later, and the deadline has to run
 * from the tap (AD2), the same reason `recordDose` takes an explicit `actualTime`.
 */
export function buildDoseSnooze(
  occurrenceId: string,
  minutes: number,
  priorCount: number,
  context: SnoozeContext,
  atMs?: EpochMs,
): DoseSnooze {
  return {
    id: context.ids.next(),
    occurrenceId,
    minutes,
    count: priorCount + 1,
    createdAt: atMs === undefined ? context.clock.nowIso() : toIso(atMs),
    createdByUserId: context.userId,
    createdByDeviceId: context.deviceId,
    syncStatus: 'pending',
  };
}
