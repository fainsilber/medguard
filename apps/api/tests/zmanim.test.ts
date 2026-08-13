import { describe, expect, it } from 'vitest';
import { SINGLE_PATIENT_ID, formatLocalTime, fromIso } from '@medguard/shared';
import type { ShabbatConfig } from '@medguard/shared';
import { computeWindows, parseHavdalah } from '../src/shabbat/zmanim.js';

/**
 * The zmanim computation, against fixed 2026 dates.
 *
 * These fixtures are the machine half of the Sprint 6 exit gate — the other half is a human
 * checking eight weeks of these against a luach on the verification screen. What is asserted here
 * is what automation *can* prove: that a three-day sequence comes out as one continuous window,
 * that Israel and the diaspora diverge in the right direction, that the configured candle-lighting
 * offset is the one actually used, and that a DST boundary moves the local time rather than
 * silently moving the instant.
 */

const JERUSALEM = 'Asia/Jerusalem';
const NEW_YORK = 'America/New_York';

function makeConfig(overrides: Partial<ShabbatConfig> = {}): ShabbatConfig {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    patientId: SINGLE_PATIENT_ID,
    autoShabbatEnabled: true,
    latitude: 31.7683,
    longitude: 35.2137,
    candleLightingOffsetMins: 18,
    havdalahDegreesOrMins: '8.5_degrees',
    israelHolidays: true,
    chimeDurationSeconds: 45,
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

const DIASPORA = makeConfig({
  latitude: 40.7128,
  longitude: -74.006,
  israelHolidays: false,
});

function range(fromIsoStr: string, toIsoStr: string) {
  return { fromMs: fromIso(fromIsoStr), toMs: fromIso(toIsoStr) };
}

describe('parseHavdalah', () => {
  it('maps the two configured forms onto hebcal options', () => {
    expect(parseHavdalah('8.5_degrees')).toEqual({ havdalahDeg: 8.5 });
    expect(parseHavdalah('50_mins')).toEqual({ havdalahMins: 50 });
  });

  it('falls back to tzeit rather than producing no windows at all', () => {
    // A stored config predating the current format must still yield a Havdalah: no Havdalah means
    // a window that never closes, which reads on a device as "Shabbat mode never ends".
    expect(parseHavdalah('sometime after dark')).toEqual({ havdalahDeg: 8.5 });
  });
});

describe('computeWindows', () => {
  it('produces an ordinary Shabbat from candle lighting to Havdalah', () => {
    const windows = computeWindows(
      makeConfig(),
      JERUSALEM,
      range('2026-08-13T00:00:00.000Z', '2026-08-17T00:00:00.000Z'),
    );

    expect(windows).toEqual([
      {
        id: 'shabbat:2026-08-14T16:03:00.000Z',
        kind: 'shabbat',
        label: 'Shabbat',
        startsAt: '2026-08-14T16:03:00.000Z',
        endsAt: '2026-08-15T17:01:00.000Z',
      },
    ]);
  });

  it('honours the household candle-lighting offset instead of a municipal custom', () => {
    // The trap this guards: hebcal applies a city's own minhag (40 minutes for Jerusalem, 30 for
    // Haifa) when a Location carries a recognised name, silently overriding candleLightingMins.
    // A household that set 18 would be shown 18 and given 40. Same coordinates, two offsets:
    const eighteen = computeWindows(
      makeConfig(),
      JERUSALEM,
      range('2026-08-13T00:00:00.000Z', '2026-08-17T00:00:00.000Z'),
    );
    const forty = computeWindows(
      makeConfig({ candleLightingOffsetMins: 40 }),
      JERUSALEM,
      range('2026-08-13T00:00:00.000Z', '2026-08-17T00:00:00.000Z'),
    );

    // Roughly the 22 minutes between the two offsets — "roughly" because hebcal rounds each
    // computed time to the nearest minute, which the difference inherits.
    const gapMinutes = (fromIso(eighteen[0]!.startsAt) - fromIso(forty[0]!.startsAt)) / 60_000;
    expect(gapMinutes).toBeGreaterThanOrEqual(20);
    expect(gapMinutes).toBeLessThanOrEqual(23);
    // And the Havdalah end is untouched by the candle-lighting offset.
    expect(forty[0]!.endsAt).toBe(eighteen[0]!.endsAt);
  });

  it('takes a Havdalah given in minutes after sunset', () => {
    const [tzeit] = computeWindows(
      makeConfig(),
      JERUSALEM,
      range('2026-08-13T00:00:00.000Z', '2026-08-17T00:00:00.000Z'),
    );
    const [fifty] = computeWindows(
      makeConfig({ havdalahDegreesOrMins: '50_mins' }),
      JERUSALEM,
      range('2026-08-13T00:00:00.000Z', '2026-08-17T00:00:00.000Z'),
    );

    expect(fifty!.endsAt).not.toBe(tzeit!.endsAt);
    expect(fromIso(fifty!.endsAt)).toBeGreaterThan(fromIso(tzeit!.startsAt));
  });

  it('merges a three-day chag adjacent to Shabbat into one continuous window', () => {
    // Rosh Hashana 5787: Erev on Friday 11 September 2026, chag through Sunday 13 September.
    // A per-day model would emit three windows with gaps between them, and a device would leave
    // Shabbat mode on Saturday night in the middle of a chag.
    const windows = computeWindows(
      makeConfig(),
      JERUSALEM,
      range('2026-09-10T00:00:00.000Z', '2026-09-15T00:00:00.000Z'),
    );

    expect(windows).toEqual([
      {
        id: 'shabbat:2026-09-11T15:30:00.000Z',
        kind: 'combined',
        label: 'Shabbat · Rosh Hashana',
        startsAt: '2026-09-11T15:30:00.000Z',
        endsAt: '2026-09-13T16:24:00.000Z',
      },
    ]);

    const window = windows[0]!;
    const spanHours = (fromIso(window.endsAt) - fromIso(window.startsAt)) / 3_600_000;
    expect(spanHours).toBeGreaterThan(48);
  });

  it('labels a Yom Tov with no Shabbat in it as yom_tov', () => {
    // Yom Kippur 5787 falls Sunday night to Monday night — no Shabbat involved.
    const windows = computeWindows(
      makeConfig(),
      JERUSALEM,
      range('2026-09-20T00:00:00.000Z', '2026-09-22T00:00:00.000Z'),
    );

    expect(windows).toEqual([
      {
        id: 'shabbat:2026-09-20T15:18:00.000Z',
        kind: 'yom_tov',
        label: 'Yom Kippur',
        startsAt: '2026-09-20T15:18:00.000Z',
        endsAt: '2026-09-21T16:14:00.000Z',
      },
    ]);
  });

  it('diverges between Israel and the diaspora on the second day of a chag (delta D4)', () => {
    // Shmini Atzeret / Simchat Torah 2026, adjacent to Shabbat. Israel keeps one day, so the
    // window closes Saturday night; the diaspora keeps two, so it runs on through Sunday night.
    const israel = computeWindows(
      makeConfig(),
      JERUSALEM,
      range('2026-10-01T00:00:00.000Z', '2026-10-06T00:00:00.000Z'),
    );
    const diaspora = computeWindows(
      DIASPORA,
      NEW_YORK,
      range('2026-10-01T00:00:00.000Z', '2026-10-06T00:00:00.000Z'),
    );

    expect(israel).toHaveLength(1);
    expect(israel[0]!.endsAt).toBe('2026-10-03T15:58:00.000Z');
    expect(israel[0]!.label).toBe('Shabbat · Sukkot · Shmini Atzeret');

    expect(diaspora).toHaveLength(1);
    expect(diaspora[0]!.endsAt).toBe('2026-10-04T23:13:00.000Z');
    expect(diaspora[0]!.label).toBe('Shabbat · Sukkot · Shmini Atzeret · Simchat Torah');

    const dayMs = 24 * 3_600_000;
    const israelSpan = fromIso(israel[0]!.endsAt) - fromIso(israel[0]!.startsAt);
    const diasporaSpan = fromIso(diaspora[0]!.endsAt) - fromIso(diaspora[0]!.startsAt);
    expect(diasporaSpan - israelSpan).toBeGreaterThan(dayMs * 0.9);
  });

  it('moves the local candle-lighting time across the DST boundary, not the instant', () => {
    // Asia/Jerusalem gains an hour at 2026-03-27T00:00Z — the Friday morning of the second of
    // these two Shabbatot. The UTC instants are five minutes apart; the wall-clock times a
    // caregiver reads off a luach are an hour and five minutes apart.
    const windows = computeWindows(
      makeConfig(),
      JERUSALEM,
      range('2026-03-19T00:00:00.000Z', '2026-03-29T00:00:00.000Z'),
    );

    expect(windows.map((window) => window.startsAt)).toEqual([
      '2026-03-20T15:30:00.000Z',
      '2026-03-27T15:35:00.000Z',
    ]);
    expect(formatLocalTime(JERUSALEM, fromIso(windows[0]!.startsAt))).toBe('17:30');
    expect(formatLocalTime(JERUSALEM, fromIso(windows[1]!.startsAt))).toBe('18:35');
  });

  it('returns a window that is in progress at the start of the range', () => {
    // Saturday morning: Shabbat began yesterday evening. A range starting mid-window must still
    // produce it, or a Durable Object waking on Shabbat would decide it is a weekday.
    const windows = computeWindows(
      makeConfig(),
      JERUSALEM,
      range('2026-08-15T06:00:00.000Z', '2026-08-15T12:00:00.000Z'),
    );

    expect(windows).toHaveLength(1);
    expect(windows[0]!.startsAt).toBe('2026-08-14T16:03:00.000Z');
  });

  it('publishes only what the range asked for', () => {
    const windows = computeWindows(
      makeConfig(),
      JERUSALEM,
      range('2026-08-13T00:00:00.000Z', '2026-09-10T00:00:00.000Z'),
    );

    // Four Shabbatot in that span, and nothing from the five days of overscan either side.
    expect(windows).toHaveLength(4);
    expect(windows.every((window) => window.kind === 'shabbat')).toBe(true);
  });
});
