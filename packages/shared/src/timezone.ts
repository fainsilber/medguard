import type { EpochMs } from './clock.js';
import type { LocalDate, LocalTime } from './types.js';

/**
 * Conversion between the household's fixed wall-clock timezone and absolute instants.
 *
 * Built on `Intl.DateTimeFormat`, which delegates to the platform's IANA database, rather than
 * on a date library: the DST edge cases below are safety decisions about whether a dose is
 * skipped or doubled, and they need to be stated explicitly in our own code rather than
 * inherited from a dependency's default disambiguation policy.
 *
 * Available in browsers, workerd and Node, so `packages/shared` stays portable.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // h23 rather than hour12:false — the latter can render midnight as "24" in some locales,
      // which would silently corrupt every date rollover.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedPartsAt(timeZone: string, instantMs: EpochMs): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) {
      throw new Error(`Intl did not return a "${type}" part for zone ${timeZone}`);
    }
    return Number(part.value);
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * The wall-clock reading in `timeZone` at `instantMs`, expressed as if it were UTC.
 *
 * Not a real instant — an encoding of "what the clock on the wall says", used to compare against
 * a requested wall time.
 */
function wallMsAt(timeZone: string, instantMs: EpochMs): number {
  const { year, month, day, hour, minute, second } = zonedPartsAt(timeZone, instantMs);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

/**
 * How far ahead of UTC `timeZone` is at `instantMs`, in milliseconds.
 *
 * Floors to the second first: `Intl` only reports whole seconds, so subtracting a raw
 * millisecond-precision instant from a second-precision wall reading would fold the leftover
 * milliseconds into the offset (a 23:59:59.999 instant would report an offset 999ms short of
 * the real one). Zone offsets are whole minutes in practice, so flooring loses nothing real.
 */
export function zoneOffsetMs(timeZone: string, instantMs: EpochMs): number {
  const wholeSecondMs = Math.floor(instantMs / 1000) * 1000;
  return wallMsAt(timeZone, wholeSecondMs) - wholeSecondMs;
}

/**
 * How a requested wall-clock time mapped onto the timeline.
 *
 * The two non-exact cases only occur on DST transition days, and each is a decision about
 * patient safety rather than a formatting detail:
 *
 * - `shifted` — the requested time never happened (spring forward). Skipping the dose entirely
 *   would be the dangerous option, so it fires at the equivalent point after the jump: 02:30 on
 *   a 02:00→03:00 day becomes 03:30, preserving the elapsed interval from the previous dose.
 * - `ambiguous` — the requested time happened twice (fall back). Emitting both would double the
 *   dose, so the earlier instant wins and the later one is discarded.
 */
export type LocalResolution =
  | { kind: 'exact'; instantMs: EpochMs }
  | { kind: 'shifted'; instantMs: EpochMs; gapMs: number }
  | { kind: 'ambiguous'; instantMs: EpochMs; discardedInstantMs: EpochMs };

export function parseLocalDate(localDate: LocalDate): { year: number; month: number; day: number } {
  const [year, month, day] = localDate.split('-').map(Number) as [number, number, number];
  return { year, month, day };
}

export function parseLocalTime(localTime: LocalTime): { hour: number; minute: number } {
  const [hour, minute] = localTime.split(':').map(Number) as [number, number];
  return { hour, minute };
}

/**
 * Resolves a wall-clock date and time in `timeZone` to an absolute instant.
 *
 * Works by candidate-and-verify rather than by trusting a single offset lookup: near a
 * transition the offset at the requested wall time is exactly what's in question, so each
 * candidate is round-tripped back to a wall reading and kept only if it matches.
 */
export function resolveLocal(
  timeZone: string,
  localDate: LocalDate,
  localTime: LocalTime,
): LocalResolution {
  const { year, month, day } = parseLocalDate(localDate);
  const { hour, minute } = parseLocalTime(localTime);
  const requestedWallMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  // Sample the offset a day either side, which is comfortably outside any transition.
  const offsetBefore = zoneOffsetMs(timeZone, requestedWallMs - MS_PER_DAY);
  const offsetAfter = zoneOffsetMs(timeZone, requestedWallMs + MS_PER_DAY);

  const earlierCandidate = requestedWallMs - offsetBefore;
  const laterCandidate = requestedWallMs - offsetAfter;

  const earlierValid = wallMsAt(timeZone, earlierCandidate) === requestedWallMs;
  const laterValid = wallMsAt(timeZone, laterCandidate) === requestedWallMs;

  if (earlierValid && laterValid) {
    if (earlierCandidate === laterCandidate) {
      return { kind: 'exact', instantMs: earlierCandidate };
    }
    // Fall back: the clock read this time twice. Take the first, discard the repeat.
    return {
      kind: 'ambiguous',
      instantMs: Math.min(earlierCandidate, laterCandidate),
      discardedInstantMs: Math.max(earlierCandidate, laterCandidate),
    };
  }

  if (earlierValid) {
    return { kind: 'exact', instantMs: earlierCandidate };
  }
  if (laterValid) {
    return { kind: 'exact', instantMs: laterCandidate };
  }

  // Spring forward: the clock never read this time. Shift past the gap rather than drop the dose.
  return {
    kind: 'shifted',
    instantMs: earlierCandidate,
    gapMs: Math.abs(offsetAfter - offsetBefore),
  };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

export function formatLocalDate(timeZone: string, instantMs: EpochMs): LocalDate {
  const { year, month, day } = zonedPartsAt(timeZone, instantMs);
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export function formatLocalTime(timeZone: string, instantMs: EpochMs): LocalTime {
  const { hour, minute } = zonedPartsAt(timeZone, instantMs);
  return `${pad(hour)}:${pad(minute)}`;
}

/**
 * Calendar-day arithmetic on a `YYYY-MM-DD` string.
 *
 * Deliberately independent of any timezone: a schedule's "every 3 days" means three calendar
 * days, not 72 hours, so a DST transition in between must not shift the count.
 */
export function addLocalDays(localDate: LocalDate, days: number): LocalDate {
  const { year, month, day } = parseLocalDate(localDate);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Whole calendar days from `from` to `to`. Negative when `to` precedes `from`. */
export function localDaysBetween(from: LocalDate, to: LocalDate): number {
  const a = parseLocalDate(from);
  const b = parseLocalDate(to);
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / MS_PER_DAY,
  );
}

/** 0 = Sunday … 6 = Saturday, matching `Schedule.daysOfWeek`. */
export function localDayOfWeek(localDate: LocalDate): number {
  const { year, month, day } = parseLocalDate(localDate);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export { MS_PER_HOUR, MS_PER_MINUTE };
