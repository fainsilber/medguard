import { describe, expect, it } from 'vitest';

import { fromIso } from './clock.js';
import {
  PRE_SHABBAT_ARMING_MS,
  activeWindow,
  nextWindow,
  shabbatModeAt,
  shabbatPhaseAt,
  upcomingWindows,
} from './shabbat.js';
import { SINGLE_PATIENT_ID } from './types.js';
import type { ShabbatConfig, ShabbatWindow } from './types.js';

/**
 * Windows as the Worker publishes them, using real Jerusalem times so the fixtures stay readable
 * against a luach: Friday 14 August 2026 candle lighting 18:43 local (15:43Z), Havdalah Saturday
 * 20:01 local (17:01Z).
 */
function makeWindow(overrides: Partial<ShabbatWindow> = {}): ShabbatWindow {
  const startsAt = overrides.startsAt ?? '2026-08-14T15:43:00.000Z';
  return {
    id: `shabbat:${startsAt}`,
    patientId: SINGLE_PATIENT_ID,
    kind: 'shabbat',
    label: 'Shabbat',
    startsAt,
    endsAt: '2026-08-15T17:01:00.000Z',
    generatedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedByDeviceId: 'server',
    syncStatus: 'synced',
    ...overrides,
  };
}

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

const SHABBAT = makeWindow();
const START_MS = fromIso(SHABBAT.startsAt);
const END_MS = fromIso(SHABBAT.endsAt);

/** Rosh Hashana 5787 running into Shabbat — Friday 11 Sept to Sunday 13 Sept 2026, one window. */
const THREE_DAY = makeWindow({
  startsAt: '2026-09-11T15:30:00.000Z',
  endsAt: '2026-09-13T16:24:00.000Z',
  kind: 'combined',
  label: 'Shabbat · Rosh Hashana',
});

describe('activeWindow', () => {
  it('finds the window containing the instant', () => {
    expect(activeWindow([SHABBAT], START_MS + 3_600_000)?.id).toBe(SHABBAT.id);
  });

  it('includes the start instant and excludes the end instant', () => {
    // Half-open by design: a dose due exactly at candle lighting is in Shabbat, one due exactly
    // at Havdalah is not.
    expect(activeWindow([SHABBAT], START_MS)?.id).toBe(SHABBAT.id);
    expect(activeWindow([SHABBAT], START_MS - 1)).toBeUndefined();
    expect(activeWindow([SHABBAT], END_MS - 1)?.id).toBe(SHABBAT.id);
    expect(activeWindow([SHABBAT], END_MS)).toBeUndefined();
  });

  it('has nothing to find when no windows are published', () => {
    expect(activeWindow([], START_MS)).toBeUndefined();
  });

  it('stays inside a three-day window for its whole length', () => {
    const midChag = fromIso('2026-09-12T12:00:00.000Z');
    expect(activeWindow([THREE_DAY], midChag)?.kind).toBe('combined');
    // The gap a per-day model would have left: Saturday night, between the two chag days.
    expect(activeWindow([THREE_DAY], fromIso('2026-09-12T18:00:00.000Z'))?.id).toBe(THREE_DAY.id);
  });
});

describe('shabbatModeAt', () => {
  it('is true inside a window when automation is enabled', () => {
    expect(shabbatModeAt(makeConfig(), [SHABBAT], START_MS + 60_000)).toBe(true);
  });

  it('is false inside a window when automation is off', () => {
    expect(shabbatModeAt(makeConfig({ autoShabbatEnabled: false }), [SHABBAT], START_MS)).toBe(
      false,
    );
  });

  it('is false with no config at all', () => {
    expect(shabbatModeAt(undefined, [SHABBAT], START_MS)).toBe(false);
  });

  it('is false outside every window', () => {
    expect(shabbatModeAt(makeConfig(), [SHABBAT], END_MS + 60_000)).toBe(false);
  });
});

describe('nextWindow', () => {
  it('returns the earliest window starting at or after the instant, whatever the input order', () => {
    const windows = [THREE_DAY, SHABBAT];
    expect(nextWindow(windows, START_MS - 86_400_000)?.id).toBe(SHABBAT.id);
    expect(nextWindow(windows, END_MS)?.id).toBe(THREE_DAY.id);
  });

  it('counts a window starting exactly now', () => {
    expect(nextWindow([SHABBAT], START_MS)?.id).toBe(SHABBAT.id);
  });

  it('is undefined once nothing further has been published', () => {
    expect(nextWindow([SHABBAT], fromIso(THREE_DAY.endsAt))).toBeUndefined();
  });
});

describe('upcomingWindows', () => {
  it('lists windows in order, including one already in progress', () => {
    const listed = upcomingWindows([THREE_DAY, SHABBAT], START_MS + 60_000, 8);
    expect(listed.map((window) => window.id)).toEqual([SHABBAT.id, THREE_DAY.id]);
  });

  it('drops windows that have already ended', () => {
    expect(upcomingWindows([SHABBAT, THREE_DAY], END_MS, 8).map((w) => w.id)).toEqual([
      THREE_DAY.id,
    ]);
  });

  it('caps the list at the requested count, and treats a negative count as none', () => {
    expect(upcomingWindows([SHABBAT, THREE_DAY], START_MS, 1)).toHaveLength(1);
    expect(upcomingWindows([SHABBAT, THREE_DAY], START_MS, -1)).toHaveLength(0);
  });
});

describe('shabbatPhaseAt', () => {
  const config = makeConfig();
  const windows = [SHABBAT];

  it('is weekday when automation is off, whatever the windows say', () => {
    expect(
      shabbatPhaseAt({
        config: makeConfig({ autoShabbatEnabled: false }),
        windows,
        atMs: START_MS + 60_000,
      }),
    ).toBe('weekday');
    expect(shabbatPhaseAt({ config: undefined, windows, atMs: START_MS + 60_000 })).toBe('weekday');
  });

  it('is shabbat_active inside the window', () => {
    expect(shabbatPhaseAt({ config, windows, atMs: START_MS })).toBe('shabbat_active');
  });

  it('is pre_shabbat_arming in the hour before candle lighting, and not before that', () => {
    expect(shabbatPhaseAt({ config, windows, atMs: START_MS - PRE_SHABBAT_ARMING_MS })).toBe(
      'pre_shabbat_arming',
    );
    expect(shabbatPhaseAt({ config, windows, atMs: START_MS - PRE_SHABBAT_ARMING_MS - 1 })).toBe(
      'weekday',
    );
  });

  it('is motzei_pending after Havdalah while doses still owe an answer', () => {
    expect(
      shabbatPhaseAt({ config, windows, atMs: END_MS + 60_000, hasUnreconciledDoses: true }),
    ).toBe('motzei_pending');
  });

  it('prefers motzei_pending over arming for the next window', () => {
    // A chag ending shortly before the next window begins: unreconciled doses from the one just
    // past are the more urgent truth.
    const atMs = fromIso(THREE_DAY.startsAt) - 30 * 60_000;
    expect(
      shabbatPhaseAt({
        config,
        windows: [SHABBAT, THREE_DAY],
        atMs,
        hasUnreconciledDoses: true,
      }),
    ).toBe('motzei_pending');
  });

  it('is weekday after Havdalah once everything is reconciled', () => {
    expect(
      shabbatPhaseAt({ config, windows, atMs: END_MS + 60_000, hasUnreconciledDoses: false }),
    ).toBe('weekday');
    expect(shabbatPhaseAt({ config, windows, atMs: END_MS + 60_000 })).toBe('weekday');
  });

  it('is weekday when nothing has been published at all', () => {
    expect(shabbatPhaseAt({ config, windows: [], atMs: START_MS })).toBe('weekday');
  });
});
