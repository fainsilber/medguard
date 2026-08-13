import { CandleLightingEvent, HavdalahEvent, HebrewCalendar, Location } from '@hebcal/core';
import { MS_PER_DAY, formatLocalDate, localDayOfWeek, toIso } from '@medguard/shared';
import type { ShabbatConfig, ShabbatWindowKind } from '@medguard/shared';

/**
 * Turning a household's coordinates into the periods during which the app is in Shabbat mode.
 *
 * The only file in the system that imports `@hebcal/core` (PRD §3: zmanim are computed in the
 * Worker). Everything else — the alarm chain, both clients — reads the published
 * `ShabbatWindow` records through `packages/shared/src/shabbat.ts`, so the calendar is consulted
 * once, in one place, and every device agrees with the server by construction rather than by
 * running the same library twice and hoping.
 *
 * Pure: coordinates and a range in, windows out, no clock read and no storage touched.
 */

export interface ComputedWindow {
  /** `shabbat:<startsAt>` — see `ShabbatWindow.id`. Deterministic, so republishing is idempotent. */
  id: string;
  kind: ShabbatWindowKind;
  label: string;
  startsAt: string;
  endsAt: string;
}

export interface ZmanimRange {
  fromMs: number;
  toMs: number;
}

/**
 * How far outside the requested range the calendar is actually read.
 *
 * A window is only ever produced from a candle lighting *and* the Havdalah that closes it. Asking
 * hebcal for exactly the requested range would truncate a three-day chag that straddles either
 * end, and a half-window is worse than no window: the device would leave Shabbat mode in the
 * middle of it.
 */
const OVERSCAN_MS = 5 * MS_PER_DAY;

/** Tzeit hakochavim, hebcal's own default, used when a stored config's string is unparseable. */
const DEFAULT_HAVDALAH_DEGREES = 8.5;

type HavdalahOption = { havdalahDeg: number } | { havdalahMins: number };

/**
 * `"8.5_degrees"` / `"50_mins"` — the format `shabbatConfigSchema` already validates — mapped onto
 * hebcal's two mutually exclusive options.
 *
 * Falls back to tzeit rather than throwing: this runs inside an alarm wake, and a household whose
 * stored config predates the current format must still get *some* Havdalah rather than no windows
 * at all, which would silently look like "Shabbat mode never ends".
 */
export function parseHavdalah(value: string): HavdalahOption {
  const match = /^(\d+(?:\.\d+)?)_(degrees|mins)$/.exec(value);
  if (!match) {
    return { havdalahDeg: DEFAULT_HAVDALAH_DEGREES };
  }
  const amount = Number(match[1]);
  return match[2] === 'degrees' ? { havdalahDeg: amount } : { havdalahMins: amount };
}

/**
 * Whether the span covers a Saturday in the household's own timezone.
 *
 * Stepped in 12-hour increments rather than by calendar date arithmetic: any window that includes
 * part of Shabbat includes at least one whole night and day, so no 12-hour step can jump over it.
 */
function coversShabbat(startMs: number, endMs: number, timeZone: string): boolean {
  const SATURDAY = 6;
  for (let atMs = startMs; atMs <= endMs; atMs += MS_PER_DAY / 2) {
    if (localDayOfWeek(formatLocalDate(timeZone, atMs)) === SATURDAY) {
      return true;
    }
  }
  return localDayOfWeek(formatLocalDate(timeZone, endMs)) === SATURDAY;
}

function describe(kind: ShabbatWindowKind, holidayNames: readonly string[]): string {
  if (kind === 'shabbat') {
    return 'Shabbat';
  }
  const holidays = holidayNames.join(' · ');
  return kind === 'combined' ? `Shabbat · ${holidays}` : holidays;
}

interface OpenWindow {
  startMs: number;
  holidayNames: string[];
}

/**
 * Every Shabbat-mode window overlapping `range`.
 *
 * The algorithm is deliberately shape-driven rather than calendar-driven: hebcal emits a candle
 * lighting for each eve and exactly one Havdalah at the end of a run, so **a window opens at the
 * first candle lighting and closes at the next Havdalah**, and the intermediate candle lightings
 * of a multi-day chag are absorbed into it. Three-day sequences (chag adjacent to Shabbat) come
 * out as one continuous window with no special case, which is the property `docs/medguard-
 * sprint-plan.md` § Sprint 6 asks for and the one a per-day model gets wrong.
 *
 * Israel versus diaspora is `config.israelHolidays` (delta D4) and changes both which days are Yom
 * Tov and how many — without it, chag handling is wrong for half the year.
 */
export function computeWindows(
  config: ShabbatConfig,
  timeZone: string,
  range: ZmanimRange,
): ComputedWindow[] {
  // No city name, deliberately. Hebcal applies municipal candle-lighting customs when a Location
  // carries a recognised name — 40 minutes before sunset for "Jerusalem", 30 for "Haifa" — which
  // silently overrides `candleLightingMins`. A household that configured 18 minutes would then be
  // told 18 and given 40, so the location stays anonymous and the configured offset wins.
  const location = new Location(
    config.latitude,
    config.longitude,
    config.israelHolidays,
    timeZone,
  );

  const events = HebrewCalendar.calendar({
    start: new Date(range.fromMs - OVERSCAN_MS),
    end: new Date(range.toMs + OVERSCAN_MS),
    location,
    il: config.israelHolidays,
    candlelighting: true,
    candleLightingMins: config.candleLightingOffsetMins,
    ...parseHavdalah(config.havdalahDegreesOrMins),
  });

  const windows: ComputedWindow[] = [];
  let open: OpenWindow | null = null;

  for (const event of events) {
    // Fast-day begin/end times are `TimedEvent`s too, and a fast is not Shabbat mode.
    if (event instanceof CandleLightingEvent) {
      const holidayName = event.linkedEvent?.basename();
      if (open === null) {
        open = { startMs: event.eventTime.getTime(), holidayNames: [] };
      }
      if (holidayName !== undefined && !open.holidayNames.includes(holidayName)) {
        open.holidayNames.push(holidayName);
      }
      continue;
    }

    if (!(event instanceof HavdalahEvent)) {
      continue;
    }

    if (open === null) {
      // A Havdalah whose candle lighting fell before the overscan — nothing to close.
      continue;
    }

    const endMs = event.eventTime.getTime();
    const holidayName = event.linkedEvent?.basename();
    if (holidayName !== undefined && !open.holidayNames.includes(holidayName)) {
      open.holidayNames.push(holidayName);
    }

    const withShabbat = coversShabbat(open.startMs, endMs, timeZone);
    const kind: ShabbatWindowKind =
      open.holidayNames.length === 0 ? 'shabbat' : withShabbat ? 'combined' : 'yom_tov';

    const startsAt = toIso(open.startMs);
    windows.push({
      id: `shabbat:${startsAt}`,
      kind,
      label: describe(kind, open.holidayNames),
      startsAt,
      endsAt: toIso(endMs),
    });
    open = null;
  }

  // Overscan is a means, not an output: keep only windows that actually overlap what was asked
  // for, so a caller publishing 90 days does not also publish the five days either side of it.
  return windows.filter(
    (window) =>
      new Date(window.endsAt).getTime() > range.fromMs &&
      new Date(window.startsAt).getTime() < range.toMs,
  );
}
