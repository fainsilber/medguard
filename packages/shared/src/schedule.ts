import { toIso } from './clock.js';
import type { Clock, EpochMs, IdGenerator, IsoInstant } from './clock.js';
import {
  MS_PER_DAY,
  addLocalDays,
  formatLocalDate,
  localDayOfWeek,
  localDaysBetween,
  resolveLocal,
} from './timezone.js';
import type { DeviceId, LocalDate, LocalTime, Schedule, Uuid } from './types.js';

/**
 * Turning schedules into concrete dose occurrences.
 *
 * Pure: every input is explicit, including the clock and the household timezone, so DST
 * boundaries and month-end arithmetic are testable without waiting for a calendar.
 */

/** Refuses to expand a range this large. A UI bug asking for a century should fail loudly, not hang. */
const MAX_EXPANSION_DAYS = 3_660;

export interface Occurrence {
  scheduleId: Uuid;
  medicineId: Uuid;
  patientId: Uuid;
  /** When this dose is due. */
  dueAt: IsoInstant;
  /** The household-local date this dose belongs to. */
  localDate: LocalDate;
  /** The wall-clock time as configured — not necessarily the wall time it actually fires at. */
  scheduledLocalTime: LocalTime;
  dosageQuantity: number;
  /**
   * Present only on a DST transition day, recording that the dose does not fall on its nominal
   * wall-clock time. See `resolveLocal` for why each case resolves the way it does.
   */
  dstAdjustment?: 'shifted_forward' | 'first_of_repeat';
}

/** Half-open: `[fromMs, toMs)`, so adjacent ranges neither drop nor duplicate a dose. */
export interface ExpansionRange {
  fromMs: EpochMs;
  toMs: EpochMs;
}

/** Stable identity for an occurrence, for matching against logs and for React keys. */
export function occurrenceKey(occurrence: Occurrence): string {
  return `${occurrence.scheduleId}:${occurrence.dueAt}`;
}

/**
 * The inverse of `occurrenceKey`, for the one caller that only ever has the key: a notification
 * action tapped on a lock screen carries the key as an intent extra and nothing else.
 *
 * Splits on the *first* colon only — a UUID contains none and an ISO instant contains two, so
 * anything after the first colon is the timestamp. Returns `undefined` rather than throwing on
 * anything malformed: a corrupt notification extra must degrade to "ignore this action", never
 * crash the drain that is trying to convert a caregiver's tap into a dose record.
 */
export function parseOccurrenceKey(
  key: string,
): { scheduleId: Uuid; dueAt: IsoInstant } | undefined {
  const separator = key.indexOf(':');
  if (separator <= 0) {
    return undefined;
  }

  const scheduleId = key.slice(0, separator);
  const dueAt = key.slice(separator + 1);
  if (dueAt.length === 0) {
    return undefined;
  }

  // Round-tripping through `toIso` is what rejects "2026-13-45T99:00:00.000Z" and other strings
  // that are shaped right but are not real instants — `Date.parse` alone accepts too much.
  const parsed = Date.parse(dueAt);
  if (Number.isNaN(parsed) || toIso(parsed) !== dueAt) {
    return undefined;
  }

  return { scheduleId, dueAt };
}

/**
 * Whether a schedule version produces doses on a given local date.
 *
 * The `active` / `endDate` interaction encodes schedule versioning (safety invariant 1 — the
 * past is never rewritten):
 *
 * - `active: true` — the live version; produces doses from `startDate` on, bounded by `endDate`
 *   if it is a fixed course.
 * - `active: false` **with** `endDate` — a closed version. Still produces its historical
 *   occurrences through `endDate`, because logs reference them and editing a schedule must not
 *   retroactively delete the doses a caregiver already gave.
 * - `active: false` **without** `endDate` — fully retired, having produced nothing worth
 *   keeping. Yields no occurrences at all. This is how `reviseSchedule` retires a version that
 *   was replaced before it ever came into effect.
 */
export function scheduleIsLiveOn(schedule: Schedule, localDate: LocalDate): boolean {
  if (localDate < schedule.startDate) {
    return false;
  }

  if (schedule.endDate !== undefined) {
    if (localDate > schedule.endDate) {
      return false;
    }
  } else if (!schedule.active) {
    return false;
  }

  return true;
}

export function scheduleAppliesOn(schedule: Schedule, localDate: LocalDate): boolean {
  if (!scheduleIsLiveOn(schedule, localDate)) {
    return false;
  }

  switch (schedule.frequencyType) {
    case 'daily':
      return true;

    case 'interval_days': {
      // Defensive rather than redundant: schemas guarantee this on the way in, but expansion
      // also runs over rows already in IndexedDB, which may predate a schema change.
      const interval = schedule.intervalDays;
      if (interval === undefined || interval < 1) {
        return false;
      }
      return localDaysBetween(schedule.startDate, localDate) % interval === 0;
    }

    case 'specific_days': {
      const days = schedule.daysOfWeek;
      if (days === undefined) {
        return false;
      }
      return days.includes(localDayOfWeek(localDate));
    }
  }
}

/**
 * Every dose one schedule is due to produce within `range`, ordered by time.
 *
 * Iterates whole local days and pads a day either side of the requested range, since a local
 * date's doses can land outside the naive instant mapping once an offset is applied.
 */
export function expandSchedule(
  schedule: Schedule,
  range: ExpansionRange,
  timeZone: string,
): Occurrence[] {
  if (range.toMs <= range.fromMs) {
    return [];
  }
  if (range.toMs - range.fromMs > MAX_EXPANSION_DAYS * MS_PER_DAY) {
    throw new RangeError(
      `Refusing to expand a range longer than ${MAX_EXPANSION_DAYS} days — check the caller.`,
    );
  }

  const occurrences: Occurrence[] = [];
  const lastDate = formatLocalDate(timeZone, range.toMs + MS_PER_DAY);

  for (
    let date = formatLocalDate(timeZone, range.fromMs - MS_PER_DAY);
    date <= lastDate;
    date = addLocalDays(date, 1)
  ) {
    if (!scheduleAppliesOn(schedule, date)) {
      continue;
    }

    for (const scheduledLocalTime of schedule.timesOfDay) {
      const resolution = resolveLocal(timeZone, date, scheduledLocalTime);
      if (resolution.instantMs < range.fromMs || resolution.instantMs >= range.toMs) {
        continue;
      }

      occurrences.push({
        scheduleId: schedule.id,
        medicineId: schedule.medicineId,
        patientId: schedule.patientId,
        dueAt: toIso(resolution.instantMs),
        localDate: date,
        scheduledLocalTime,
        dosageQuantity: schedule.dosageQuantity,
        ...(resolution.kind === 'shifted' ? { dstAdjustment: 'shifted_forward' as const } : {}),
        ...(resolution.kind === 'ambiguous' ? { dstAdjustment: 'first_of_repeat' as const } : {}),
      });
    }
  }

  return occurrences.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

/**
 * Every dose across several schedules, merged and ordered.
 *
 * This is what renders an alternating regimen (delta D6): the two halves are separate schedules
 * sharing a `regimenGroupId`, and interleaving them here is what makes them read as one.
 */
export function expandSchedules(
  schedules: readonly Schedule[],
  range: ExpansionRange,
  timeZone: string,
): Occurrence[] {
  return schedules
    .flatMap((schedule) => expandSchedule(schedule, range, timeZone))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.scheduleId.localeCompare(b.scheduleId));
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

export interface RevisionContext {
  clock: Clock;
  ids: IdGenerator;
  deviceId: DeviceId;
}

/**
 * Stops a schedule from `effectiveFrom` onward without touching what came before.
 *
 * If the schedule had not started yet, it is retired outright (no `endDate`) rather than given
 * an `endDate` before its `startDate`, which would be incoherent — see `scheduleAppliesOn`.
 */
export function closeSchedule(
  schedule: Schedule,
  effectiveFrom: LocalDate,
  { clock, deviceId }: Omit<RevisionContext, 'ids'>,
): Schedule {
  const lastActiveDate = addLocalDays(effectiveFrom, -1);
  const startedBeforeChange = lastActiveDate >= schedule.startDate;

  const { endDate: _previousEndDate, ...rest } = schedule;

  return {
    ...rest,
    ...(startedBeforeChange ? { endDate: lastActiveDate } : {}),
    active: false,
    updatedAt: clock.nowIso(),
    updatedByDeviceId: deviceId,
    syncStatus: 'pending',
  };
}

export interface ScheduleRevision {
  /** The previous version, now closed. Retains its historical occurrences. */
  closed: Schedule;
  /** The new live version, starting at `effectiveFrom`. */
  created: Schedule;
}

/**
 * Edits a schedule by superseding it, never by mutating it (PRD §2.2 — "modifying a dose updates
 * future scheduled events without mutating historical intake logs").
 *
 * Returns both records; the caller writes them in one transaction so the household can never
 * observe a gap with no live schedule, or an overlap with two.
 */
export function reviseSchedule(
  existing: Schedule,
  changes: Partial<
    Pick<
      Schedule,
      | 'frequencyType'
      | 'intervalDays'
      | 'daysOfWeek'
      | 'timesOfDay'
      | 'dosageQuantity'
      | 'endDate'
      | 'regimenGroupId'
    >
  >,
  effectiveFrom: LocalDate,
  context: RevisionContext,
): ScheduleRevision {
  const { clock, ids, deviceId } = context;
  const closed = closeSchedule(existing, effectiveFrom, { clock, deviceId });

  // Drop the old version's endDate before applying changes, so a revision of a closed course
  // doesn't silently inherit a bound the caregiver didn't ask for.
  const { endDate: _oldEndDate, ...carriedOver } = existing;

  const created: Schedule = {
    ...carriedOver,
    ...changes,
    id: ids.next(),
    startDate: effectiveFrom,
    active: true,
    supersedesId: existing.id,
    updatedAt: clock.nowIso(),
    updatedByDeviceId: deviceId,
    syncStatus: 'pending',
  };

  return { closed, created };
}

/** The live version of each regimen on a given date — what the editing UI should offer. */
export function activeSchedulesOn(
  schedules: readonly Schedule[],
  localDate: LocalDate,
): Schedule[] {
  return schedules.filter((schedule) => schedule.active && scheduleAppliesOn(schedule, localDate));
}
