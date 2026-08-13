import { fromIso } from './clock.js';
import { formatLocalDate, formatLocalTime, localDayOfWeek, parseLocalDate } from './timezone.js';
import { DAY_LABELS } from './scheduleDisplay.js';
import type { ShabbatWindow } from './types.js';

/**
 * How a Shabbat window reads on the verification screen.
 *
 * Pure formatting, shared by both clients so the eight weeks a caregiver checks against a luach
 * look the same wherever they check them — and, more to the point, so there is one place that
 * decides these times are rendered in the *household's* timezone rather than the device's. A
 * caregiver in a hospital in another zone must not be shown a candle-lighting time an hour out.
 */

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** `Fri 14 Aug` — a date a caregiver can match against a printed luach at a glance. */
export function formatShabbatDate(timeZone: string, instantMs: number): string {
  const localDate = formatLocalDate(timeZone, instantMs);
  const { month, day } = parseLocalDate(localDate);
  return `${DAY_LABELS[localDayOfWeek(localDate)]} ${day} ${MONTH_LABELS[month - 1]}`;
}

export interface ShabbatWindowDisplay {
  /** e.g. `Shabbat`, `Shabbat · Rosh Hashana`. */
  label: string;
  /** e.g. `Fri 11 Sep`. */
  startDate: string;
  /** Candle lighting, `HH:MM` in the household's zone. */
  startTime: string;
  /** e.g. `Sun 13 Sep` — deliberately shown even when it is the next day, because on a chag it
   * may be two days later, and that difference is the thing being checked. */
  endDate: string;
  /** Havdalah, `HH:MM`. */
  endTime: string;
  /** True for a window covering more than one night — a chag, or a chag adjacent to Shabbat. */
  multiDay: boolean;
}

export function describeShabbatWindow(
  window: ShabbatWindow,
  timeZone: string,
): ShabbatWindowDisplay {
  const startMs = fromIso(window.startsAt);
  const endMs = fromIso(window.endsAt);
  const startDate = formatShabbatDate(timeZone, startMs);
  const endDate = formatShabbatDate(timeZone, endMs);

  return {
    label: window.label,
    startDate,
    startTime: formatLocalTime(timeZone, startMs),
    endDate,
    endTime: formatLocalTime(timeZone, endMs),
    // From the calendar dates rather than from the elapsed hours: an ordinary Shabbat is about
    // 25 hours and a two-day chag about 49, but the question being asked is "does this span more
    // than one night", which is a question about days.
    multiDay: endMs - startMs > 36 * 60 * 60 * 1000,
  };
}
