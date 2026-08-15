import { describe, expect, it } from 'vitest';

import { chimeDurationSecondsFor } from './chime.js';
import {
  DEFAULT_SHABBAT_CHIME_DURATION_SECONDS,
  DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS,
  MAX_CHIME_DURATION_SECONDS,
  MIN_CHIME_DURATION_SECONDS,
} from './settings.js';
import type { ShabbatConfig } from './types.js';

function config(overrides: Partial<ShabbatConfig> = {}): ShabbatConfig {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    patientId: '22222222-2222-4222-8222-222222222222',
    autoShabbatEnabled: true,
    latitude: 31.7683,
    longitude: 35.2137,
    candleLightingOffsetMins: 18,
    havdalahDegreesOrMins: '8.5_degrees',
    israelHolidays: true,
    chimeDurationSeconds: DEFAULT_SHABBAT_CHIME_DURATION_SECONDS,
    weekdayChimeDurationSeconds: DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS,
    updatedAt: '2026-08-14T12:00:00.000Z',
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('chimeDurationSecondsFor', () => {
  it('rings for the configured weekday length off Shabbat', () => {
    const seconds = chimeDurationSecondsFor({
      inShabbat: false,
      shabbatConfig: config({ weekdayChimeDurationSeconds: 90 }),
    });

    expect(seconds).toBe(90);
  });

  it('rings for the configured Shabbat length in mode', () => {
    const seconds = chimeDurationSecondsFor({
      inShabbat: true,
      shabbatConfig: config({ chimeDurationSeconds: 20 }),
    });

    expect(seconds).toBe(20);
  });

  it('takes both defaults when no config has synced yet', () => {
    expect(chimeDurationSecondsFor({ inShabbat: false })).toBe(
      DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS,
    );
    expect(chimeDurationSecondsFor({ inShabbat: true })).toBe(
      DEFAULT_SHABBAT_CHIME_DURATION_SECONDS,
    );
  });

  it('treats an explicitly undefined config the same as a missing one', () => {
    expect(chimeDurationSecondsFor({ inShabbat: false, shabbatConfig: undefined })).toBe(
      DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS,
    );
  });

  /**
   * The back-compat case that matters: every household that existed before the weekday/Shabbat
   * split has a config carrying only `chimeDurationSeconds`. Its weekday alerts must land on the
   * new default rather than inheriting the Shabbat number, which would silently shorten the alert
   * a caregiver is actually expected to act on.
   */
  it('does not inherit the Shabbat length onto weekdays for a pre-split config', () => {
    const legacy = config({ chimeDurationSeconds: 45 });
    delete legacy.weekdayChimeDurationSeconds;

    expect(chimeDurationSecondsFor({ inShabbat: false, shabbatConfig: legacy })).toBe(
      DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS,
    );
    expect(chimeDurationSecondsFor({ inShabbat: true, shabbatConfig: legacy })).toBe(45);
  });

  describe('clamping', () => {
    it('never rings longer than the ceiling, whatever the record says', () => {
      expect(
        chimeDurationSecondsFor({
          inShabbat: true,
          shabbatConfig: config({ chimeDurationSeconds: 86_400 }),
        }),
      ).toBe(MAX_CHIME_DURATION_SECONDS);

      expect(
        chimeDurationSecondsFor({
          inShabbat: false,
          shabbatConfig: config({ weekdayChimeDurationSeconds: 86_400 }),
        }),
      ).toBe(MAX_CHIME_DURATION_SECONDS);
    });

    it('never rings so briefly it cannot be noticed', () => {
      expect(
        chimeDurationSecondsFor({
          inShabbat: true,
          shabbatConfig: config({ chimeDurationSeconds: 0 }),
        }),
      ).toBe(MIN_CHIME_DURATION_SECONDS);

      expect(
        chimeDurationSecondsFor({
          inShabbat: false,
          shabbatConfig: config({ weekdayChimeDurationSeconds: -30 }),
        }),
      ).toBe(MIN_CHIME_DURATION_SECONDS);
    });

    it('rounds a fractional length to a whole second', () => {
      expect(
        chimeDurationSecondsFor({
          inShabbat: false,
          shabbatConfig: config({ weekdayChimeDurationSeconds: 42.6 }),
        }),
      ).toBe(43);
    });

    /**
     * `Number(text)` on an empty settings field yields `NaN`, and `NaN` compared against bounds is
     * false in both directions — so an unguarded clamp would pass it straight through to a
     * `MediaPlayer` timeout of `NaN` milliseconds.
     */
    it('falls back to the weekday default rather than passing a non-finite length through', () => {
      expect(
        chimeDurationSecondsFor({
          inShabbat: true,
          shabbatConfig: config({ chimeDurationSeconds: Number.NaN }),
        }),
      ).toBe(DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS);

      expect(
        chimeDurationSecondsFor({
          inShabbat: false,
          shabbatConfig: config({ weekdayChimeDurationSeconds: Number.POSITIVE_INFINITY }),
        }),
      ).toBe(DEFAULT_WEEKDAY_CHIME_DURATION_SECONDS);
    });
  });
});
