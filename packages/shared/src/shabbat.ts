import { CandleLightingEvent, HavdalahEvent, HebrewCalendar, Location } from '@hebcal/core';
import type { EpochMs, IsoInstant } from './clock.js';
import { fromIso, toIso } from './clock.js';
import { MS_PER_DAY } from './timezone.js';
import type { ShabbatConfig } from './types.js';

/**
 * Server-side zmanim computation (Sprint 6), delegated entirely to `@hebcal/core` rather than
 * reimplemented — cross-cutting rule 5 applies here too: this is the one place a halachically
 * sensitive calculation happens, computed once on the server and synced down, never duplicated
 * on-device (see `docs/android-client-plan.md` "Shabbat on native").
 */

export type ShabbatZmanimConfig = Pick<
  ShabbatConfig,
  'latitude' | 'longitude' | 'candleLightingOffsetMins' | 'havdalahDegreesOrMins' | 'israelHolidays'
>;

/**
 * One continuous Shabbat/Yom Tov period: candle lighting at the start to the final Havdalah at
 * the end. A three-day chag (delta D6... see D4) collapses to one window rather than one per
 * calendar day, because the state machine only ever needs "are we in mode right now" — the
 * individual day boundaries inside a chag are not decision points.
 */
export interface ShabbatWindow {
  startsAt: IsoInstant;
  endsAt: IsoInstant;
  /** Best-effort human label for the verification screen, e.g. "Shabbat" or "Rosh Hashana 5787". */
  label: string;
}

/** `havdalahDegreesOrMins` is validated by `shabbatConfigSchema` as `<number>_degrees` or `<number>_mins`. */
function havdalahOption(value: string): { havdalahDeg: number } | { havdalahMins: number } {
  const match = /^(\d+(?:\.\d+)?)_(degrees|mins)$/.exec(value);
  if (!match) {
    throw new RangeError(`Not a valid havdalahDegreesOrMins value: ${JSON.stringify(value)}`);
  }
  const amount = Number(match[1]);
  return match[2] === 'degrees' ? { havdalahDeg: amount } : { havdalahMins: amount };
}

/** Prefers a linked event's own name over the "Erev X" naming of the window's first candle-lighting. */
function betterLabel(current: string, candidate: string | undefined): string {
  if (!candidate) {
    return current;
  }
  if (current === 'Shabbat' || current.startsWith('Erev ')) {
    return candidate;
  }
  return current;
}

/**
 * Computes every continuous Shabbat/Yom Tov window overlapping `[fromMs, toMs)`.
 *
 * Windows are merged across a multi-day chag: `@hebcal/core` emits one `CandleLightingEvent` per
 * evening (including the "borrowed flame" lighting on a second Yom Tov night) and only one
 * `HavdalahEvent` at the true end, so grouping consecutive candle-lightings with no Havdalah
 * between them is exactly what the halachic continuity is — nothing here decides that itself.
 */
export function computeShabbatWindows(
  config: ShabbatZmanimConfig,
  timeZone: string,
  range: { fromMs: EpochMs; toMs: EpochMs },
): ShabbatWindow[] {
  const location = new Location(config.latitude, config.longitude, config.israelHolidays, timeZone);
  const events = HebrewCalendar.calendar({
    location,
    start: new Date(range.fromMs),
    end: new Date(range.toMs),
    candlelighting: true,
    il: config.israelHolidays,
    candleLightingMins: config.candleLightingOffsetMins,
    ...havdalahOption(config.havdalahDegreesOrMins),
  });

  const windows: ShabbatWindow[] = [];
  let openStartMs: EpochMs | null = null;
  let openLabel = 'Shabbat';

  for (const event of events) {
    if (event instanceof CandleLightingEvent) {
      if (openStartMs === null) {
        openStartMs = event.eventTime.getTime();
        openLabel = 'Shabbat';
      }
      openLabel = betterLabel(openLabel, event.linkedEvent?.getDesc());
      continue;
    }
    if (event instanceof HavdalahEvent && openStartMs !== null) {
      windows.push({
        startsAt: toIso(openStartMs),
        endsAt: toIso(event.eventTime.getTime()),
        label: openLabel,
      });
      openStartMs = null;
    }
  }

  return windows;
}

export function isWithinShabbatWindows(windows: readonly ShabbatWindow[], atMs: EpochMs): boolean {
  return windows.some((w) => atMs >= fromIso(w.startsAt) && atMs < fromIso(w.endsAt));
}

/**
 * Wide enough to contain the candle-lighting start of any window that could still be open at
 * `atMs` — the longest realistic run is a three-day chag (~72h) plus a comfortable margin for
 * latitude-driven early candle lighting, never calendar days of drift.
 */
const LOOKBACK_MS = 5 * MS_PER_DAY;

/**
 * Whether `atMs` falls inside Shabbat/Yom Tov mode.
 *
 * Queries a padded window around `atMs` rather than trusting a caller-supplied range: asking
 * "am I in mode right now" must work correctly even when `atMs` lands mid-Shabbat and the
 * candle-lighting that started it is in the past — the exact "recovering correctly after a
 * reload mid-Shabbat" requirement from the sprint plan.
 */
export function isShabbatModeAt(
  config: ShabbatZmanimConfig,
  timeZone: string,
  atMs: EpochMs,
): boolean {
  const windows = computeShabbatWindows(config, timeZone, {
    fromMs: atMs - LOOKBACK_MS,
    toMs: atMs + MS_PER_DAY,
  });
  return isWithinShabbatWindows(windows, atMs);
}
