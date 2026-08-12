import { describe, expect, it } from 'vitest';
import { fromIso } from './clock.js';
import { computeShabbatWindows, isShabbatModeAt, isWithinShabbatWindows } from './shabbat.js';
import type { ShabbatZmanimConfig } from './shabbat.js';

/**
 * Fixtures generated directly against `@hebcal/core` for Aug–Nov 2026 and checked by hand against
 * published zmanim, per the Sprint 6 test plan ("zmanim fixtures across dates and locations").
 * This module is a thin, deliberately non-reimplementing wrapper (cross-cutting rule 5) around
 * `@hebcal/core`'s own computation, so these fixtures exist to catch a wiring mistake in *our*
 * code — wrong options passed, wrong merge logic — not to re-verify the astronomy.
 */

const JERUSALEM_ISRAEL: ShabbatZmanimConfig = {
  latitude: 31.7683,
  longitude: 35.2137,
  candleLightingOffsetMins: 18,
  havdalahDegreesOrMins: '8.5_degrees',
  israelHolidays: true,
};

const NYC_DIASPORA: ShabbatZmanimConfig = {
  latitude: 40.7128,
  longitude: -74.006,
  candleLightingOffsetMins: 18,
  havdalahDegreesOrMins: '42_mins',
  israelHolidays: false,
};

function range(fromIsoDate: string, toIsoDate: string) {
  return { fromMs: fromIso(`${fromIsoDate}T00:00:00.000Z`), toMs: fromIso(`${toIsoDate}T00:00:00.000Z`) };
}

describe('computeShabbatWindows', () => {
  it('computes a plain Shabbat as one window, degrees-based Havdalah', () => {
    const windows = computeShabbatWindows(
      JERUSALEM_ISRAEL,
      'Asia/Jerusalem',
      range('2026-08-13', '2026-08-16'),
    );
    expect(windows).toEqual([
      { startsAt: '2026-08-14T16:03:00.000Z', endsAt: '2026-08-15T17:01:00.000Z', label: 'Shabbat' },
    ]);
  });

  it('computes a plain Shabbat as one window, minutes-based Havdalah', () => {
    const windows = computeShabbatWindows(
      NYC_DIASPORA,
      'America/New_York',
      range('2026-08-13', '2026-08-16'),
    );
    expect(windows).toEqual([
      { startsAt: '2026-08-14T23:37:00.000Z', endsAt: '2026-08-16T00:36:00.000Z', label: 'Shabbat' },
    ]);
  });

  it('merges a three-day chag (Shabbat + two-day Rosh Hashana) into one window, diaspora', () => {
    const windows = computeShabbatWindows(
      NYC_DIASPORA,
      'America/New_York',
      range('2026-09-10', '2026-09-16'),
    );
    expect(windows).toEqual([
      {
        startsAt: '2026-09-11T22:53:00.000Z',
        endsAt: '2026-09-13T23:50:00.000Z',
        label: 'Rosh Hashana 5787',
      },
    ]);
  });

  it('merges the same three-day run into a shorter window in Israel (one-day Yom Tov)', () => {
    const windows = computeShabbatWindows(
      JERUSALEM_ISRAEL,
      'Asia/Jerusalem',
      range('2026-09-10', '2026-09-16'),
    );
    expect(windows).toEqual([
      {
        startsAt: '2026-09-11T15:30:00.000Z',
        endsAt: '2026-09-13T16:24:00.000Z',
        label: 'Rosh Hashana 5787',
      },
    ]);
  });

  it('diverges around Sukkot/Shmini Atzeret: Israel one day, diaspora two merged with a Shabbat', () => {
    const israel = computeShabbatWindows(
      JERUSALEM_ISRAEL,
      'Asia/Jerusalem',
      range('2026-09-25', '2026-10-05'),
    );
    // Erev Sukkot (Fri) merges with Sukkot I, which is also Shabbat this year — one window, not two.
    expect(israel).toEqual([
      { startsAt: '2026-09-25T15:12:00.000Z', endsAt: '2026-09-26T16:07:00.000Z', label: 'Erev Sukkot' },
      {
        startsAt: '2026-10-02T15:03:00.000Z',
        endsAt: '2026-10-03T15:58:00.000Z',
        label: 'Sukkot VII (Hoshana Raba)',
      },
    ]);

    const diaspora = computeShabbatWindows(
      NYC_DIASPORA,
      'America/New_York',
      range('2026-09-25', '2026-10-05'),
    );
    // Diaspora's two-day Sukkot is itself a merged window, separate from Shmini Atzeret/Simchat
    // Torah's own two-day merge four days later — divergence from Israel's single-day windows.
    expect(diaspora).toEqual([
      { startsAt: '2026-09-25T22:30:00.000Z', endsAt: '2026-09-27T23:27:00.000Z', label: 'Sukkot I' },
      {
        startsAt: '2026-10-02T22:18:00.000Z',
        endsAt: '2026-10-04T23:15:00.000Z',
        label: 'Sukkot VII (Hoshana Raba)',
      },
    ]);
  });

  it('produces correct absolute instants either side of the US DST fallback boundary (Nov 1 2026)', () => {
    const windows = computeShabbatWindows(
      NYC_DIASPORA,
      'America/New_York',
      range('2026-10-29', '2026-11-08'),
    );
    // Everything in this module is absolute-instant arithmetic (candle-lighting/Havdalah are
    // physical sunset-relative events), so the household's civil-clock DST transition in between
    // must not perturb either window — no special-casing needed, unlike wall-clock dose times.
    expect(windows).toEqual([
      { startsAt: '2026-10-30T21:36:00.000Z', endsAt: '2026-10-31T22:35:00.000Z', label: 'Shabbat' },
      { startsAt: '2026-11-06T21:28:00.000Z', endsAt: '2026-11-07T22:27:00.000Z', label: 'Shabbat' },
    ]);
  });

  it('returns no windows for a range with no Shabbat or Yom Tov', () => {
    const windows = computeShabbatWindows(
      JERUSALEM_ISRAEL,
      'Asia/Jerusalem',
      { fromMs: fromIso('2026-08-16T00:00:00.000Z'), toMs: fromIso('2026-08-17T00:00:00.000Z') },
    );
    expect(windows).toEqual([]);
  });
});

describe('isWithinShabbatWindows', () => {
  const windows = [{ startsAt: '2026-08-14T16:03:00.000Z', endsAt: '2026-08-15T17:01:00.000Z', label: 'Shabbat' }];

  it('is true at the start instant (candle lighting) and false at the end instant (Havdalah)', () => {
    expect(isWithinShabbatWindows(windows, fromIso('2026-08-14T16:03:00.000Z'))).toBe(true);
    expect(isWithinShabbatWindows(windows, fromIso('2026-08-15T17:01:00.000Z'))).toBe(false);
  });

  it('is true strictly inside the window and false strictly outside it', () => {
    expect(isWithinShabbatWindows(windows, fromIso('2026-08-15T00:00:00.000Z'))).toBe(true);
    expect(isWithinShabbatWindows(windows, fromIso('2026-08-14T00:00:00.000Z'))).toBe(false);
    expect(isWithinShabbatWindows(windows, fromIso('2026-08-16T00:00:00.000Z'))).toBe(false);
  });
});

describe('isShabbatModeAt', () => {
  it('recovers mid-Shabbat with no range supplied by the caller (reload-mid-Shabbat safety)', () => {
    // Deep inside the window with no candle-lighting event anywhere near `atMs` itself — this is
    // what a device (or the DO) asks the instant it wakes up, with no memory of when mode began.
    const midShabbat = fromIso('2026-08-15T06:00:00.000Z');
    expect(isShabbatModeAt(JERUSALEM_ISRAEL, 'Asia/Jerusalem', midShabbat)).toBe(true);
  });

  it('is false just before candle lighting and just after Havdalah', () => {
    expect(
      isShabbatModeAt(JERUSALEM_ISRAEL, 'Asia/Jerusalem', fromIso('2026-08-14T16:02:59.000Z')),
    ).toBe(false);
    expect(
      isShabbatModeAt(JERUSALEM_ISRAEL, 'Asia/Jerusalem', fromIso('2026-08-15T17:01:01.000Z')),
    ).toBe(false);
  });

  it('is true throughout a merged three-day chag, including the middle day with no event of its own', () => {
    const middleOfRoshHashana = fromIso('2026-09-12T12:00:00.000Z');
    expect(isShabbatModeAt(NYC_DIASPORA, 'America/New_York', middleOfRoshHashana)).toBe(true);
  });

  it('holds correctly on both sides of the US DST fallback boundary', () => {
    expect(
      isShabbatModeAt(NYC_DIASPORA, 'America/New_York', fromIso('2026-10-31T00:00:00.000Z')),
    ).toBe(true);
    expect(
      isShabbatModeAt(NYC_DIASPORA, 'America/New_York', fromIso('2026-11-02T00:00:00.000Z')),
    ).toBe(false);
    expect(
      isShabbatModeAt(NYC_DIASPORA, 'America/New_York', fromIso('2026-11-07T00:00:00.000Z')),
    ).toBe(true);
  });

  it('rejects a malformed havdalahDegreesOrMins loudly rather than silently miscalculating', () => {
    const badConfig = { ...JERUSALEM_ISRAEL, havdalahDegreesOrMins: 'not-a-value' };
    expect(() => computeShabbatWindows(badConfig, 'Asia/Jerusalem', range('2026-08-13', '2026-08-16'))).toThrow(
      RangeError,
    );
  });
});
