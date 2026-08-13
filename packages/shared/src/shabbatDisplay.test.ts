import { describe, expect, it } from 'vitest';

import { describeShabbatWindow, formatShabbatDate } from './shabbatDisplay.js';
import { fromIso } from './clock.js';
import type { ShabbatWindow } from './types.js';

const JERUSALEM = 'Asia/Jerusalem';
const NEW_YORK = 'America/New_York';

function makeWindow(overrides: Partial<ShabbatWindow> = {}): ShabbatWindow {
  const startsAt = overrides.startsAt ?? '2026-08-14T16:03:00.000Z';
  return {
    id: `shabbat:${startsAt}`,
    patientId: '00000000-0000-4000-8000-000000000001',
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

describe('formatShabbatDate', () => {
  it('names the weekday and month in the household timezone', () => {
    expect(formatShabbatDate(JERUSALEM, fromIso('2026-08-14T16:03:00.000Z'))).toBe('Fri 14 Aug');
  });

  it('uses the household zone, not the reader s— a late-evening instant is still that day', () => {
    // 23:30 in New York on the 14th is 06:30 on the 15th in Jerusalem. A caregiver checking a
    // Jerusalem luach must see the Jerusalem day.
    const instant = fromIso('2026-08-15T03:30:00.000Z');
    expect(formatShabbatDate(NEW_YORK, instant)).toBe('Fri 14 Aug');
    expect(formatShabbatDate(JERUSALEM, instant)).toBe('Sat 15 Aug');
  });
});

describe('describeShabbatWindow', () => {
  it('renders candle lighting and Havdalah in the household zone', () => {
    expect(describeShabbatWindow(makeWindow(), JERUSALEM)).toEqual({
      label: 'Shabbat',
      startDate: 'Fri 14 Aug',
      startTime: '19:03',
      endDate: 'Sat 15 Aug',
      endTime: '20:01',
      multiDay: false,
    });
  });

  it('marks a three-day chag as multi-day', () => {
    const display = describeShabbatWindow(
      makeWindow({
        startsAt: '2026-09-11T15:30:00.000Z',
        endsAt: '2026-09-13T16:24:00.000Z',
        kind: 'combined',
        label: 'Shabbat · Rosh Hashana',
      }),
      JERUSALEM,
    );

    expect(display).toMatchObject({
      label: 'Shabbat · Rosh Hashana',
      startDate: 'Fri 11 Sep',
      endDate: 'Sun 13 Sep',
      multiDay: true,
    });
  });

  it('does not call an ordinary 25-hour Shabbat multi-day', () => {
    expect(describeShabbatWindow(makeWindow(), JERUSALEM).multiDay).toBe(false);
  });
});
