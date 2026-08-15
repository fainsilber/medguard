import { describe, expect, it } from 'vitest';

import { fromIso } from './clock.js';
import {
  RECONCILIATION_LOOKBACK_MS,
  collectReconciliationItems,
  hasUnreconciledDoses,
  isReconcilableAt,
} from './shabbatReconciliation.js';
import { shabbatPhaseAt } from './shabbat.js';
import type { IntakeLog, Medicine, Schedule, ShabbatConfig, ShabbatWindow } from './types.js';

/**
 * What the Motzei sheet asks about.
 *
 * The property that matters most here is completeness: a dose whose alert never fired — the server
 * was never woken, the phone was offline all of Shabbat — was still given or not given, and a list
 * built from the `pending_shabbat` logs alone would never mention it.
 */

const JERUSALEM = 'Asia/Jerusalem';

/** Shabbat 14–15 August 2026: candle lighting 19:03 local, Havdalah 20:01 the next night. */
const WINDOW_START = '2026-08-14T16:03:00.000Z';
const WINDOW_END = '2026-08-15T17:01:00.000Z';
/** Sunday morning, after Havdalah. */
const AFTER = fromIso('2026-08-16T06:00:00.000Z');

function makeWindow(overrides: Partial<ShabbatWindow> = {}): ShabbatWindow {
  const startsAt = overrides.startsAt ?? WINDOW_START;
  return {
    id: `shabbat:${startsAt}`,
    patientId: 'patient-1',
    kind: 'shabbat',
    label: 'Shabbat',
    startsAt,
    endsAt: WINDOW_END,
    generatedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedByDeviceId: 'server',
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeMedicine(overrides: Partial<Medicine> = {}): Medicine {
  return {
    id: 'medicine-1',
    patientId: 'patient-1',
    name: 'Ondansetron',
    strength: '4mg',
    form: 'pill',
    asNeeded: false,
    archived: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

/** Twice a day at 09:00 and 21:00 Jerusalem, so the window above contains three doses. */
function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    medicineId: 'medicine-1',
    patientId: 'patient-1',
    frequencyType: 'daily',
    timesOfDay: ['09:00', '21:00'],
    dosageQuantity: 1,
    startDate: '2026-01-01',
    active: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeLog(overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id: 'log-1',
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    scheduleId: 'schedule-1',
    type: 'scheduled',
    status: 'pending_shabbat',
    scheduledTime: '2026-08-14T18:00:00.000Z',
    actualTime: '2026-08-14T18:00:00.000Z',
    quantityTaken: 0,
    loggedByUserId: 'system',
    loggedByDeviceId: 'system',
    syncStatus: 'synced',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<ShabbatConfig> = {}): ShabbatConfig {
  return {
    id: 'shabbat-config-1',
    patientId: 'patient-1',
    autoShabbatEnabled: true,
    latitude: 31.7683,
    longitude: 35.2137,
    candleLightingOffsetMins: 18,
    havdalahDegreesOrMins: '8.5_degrees',
    israelHolidays: true,
    chimeDurationSeconds: 30,
    weekdayChimeDurationSeconds: 60,
    updatedAt: '2026-08-01T00:00:00.000Z',
    updatedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

function baseInput(overrides: Partial<Parameters<typeof collectReconciliationItems>[0]> = {}) {
  return {
    windows: [makeWindow()],
    schedules: [makeSchedule()],
    medicines: [makeMedicine()],
    logs: [] as IntakeLog[],
    timeZone: JERUSALEM,
    nowMs: AFTER,
    ...overrides,
  };
}

describe('collectReconciliationItems', () => {
  it('lists every dose in the window, earliest first', () => {
    const items = collectReconciliationItems(baseInput());

    // Friday 21:00, Saturday 09:00, Saturday 21:00 — the 21:00 Saturday dose falls after Havdalah
    // (20:01) and so is an ordinary weekday dose, not a Shabbat one.
    expect(items.map((item) => item.occurrence.scheduledLocalTime)).toEqual(['21:00', '09:00']);
    expect(items.map((item) => item.medicineName)).toEqual(['Ondansetron', 'Ondansetron']);
  });

  it('lists a dose whose alert never fired, with no pending log to go on', () => {
    // The server was never woken, or the household was offline all of Shabbat. The doses still
    // happened or did not, and a sheet built from the pending logs alone would never ask.
    const items = collectReconciliationItems(baseInput({ logs: [] }));

    expect(items).toHaveLength(2);
    expect(items.every((item) => item.pendingLog === undefined)).toBe(true);
  });

  it('carries the pending log when the server recorded one', () => {
    const items = collectReconciliationItems(
      baseInput({
        logs: [makeLog({ scheduledTime: '2026-08-14T18:00:00.000Z' })],
      }),
    );

    expect(items[0]!.pendingLog?.status).toBe('pending_shabbat');
    expect(items[1]!.pendingLog).toBeUndefined();
  });

  it('drops a dose that already has a real answer', () => {
    const items = collectReconciliationItems(
      baseInput({
        logs: [
          makeLog({
            id: 'answered',
            status: 'taken',
            scheduledTime: '2026-08-14T18:00:00.000Z',
            quantityTaken: 1,
            loggedByUserId: 'mom',
          }),
        ],
      }),
    );

    expect(items.map((item) => item.occurrence.scheduledLocalTime)).toEqual(['09:00']);
  });

  it('drops a dose whose pending log was already superseded by a correction', () => {
    // The other caregiver reconciled this one already; `effectiveLogs` follows the chain.
    const pending = makeLog({ id: 'pending', scheduledTime: '2026-08-14T18:00:00.000Z' });
    const answered = makeLog({
      id: 'answered',
      status: 'taken',
      quantityTaken: 1,
      loggedByUserId: 'dad',
      supersedesId: 'pending',
      scheduledTime: '2026-08-14T18:00:00.000Z',
    });

    const items = collectReconciliationItems(baseInput({ logs: [pending, answered] }));

    expect(items.map((item) => item.occurrence.scheduledLocalTime)).toEqual(['09:00']);
  });

  it('ignores an archived medicine', () => {
    const items = collectReconciliationItems(
      baseInput({ medicines: [makeMedicine({ archived: true })] }),
    );

    expect(items).toEqual([]);
  });

  it('asks nothing while the window is still running', () => {
    // Saturday lunchtime: recording is exactly what must not happen yet.
    const items = collectReconciliationItems(
      baseInput({ nowMs: fromIso('2026-08-15T09:00:00.000Z') }),
    );

    expect(items).toEqual([]);
  });

  it('forgets a window older than the lookback', () => {
    const items = collectReconciliationItems(
      baseInput({ nowMs: AFTER + RECONCILIATION_LOOKBACK_MS + 1 }),
    );

    expect(items).toEqual([]);
  });

  it('covers a whole three-day window rather than only its last night', () => {
    // Rosh Hashana 5787 running into Shabbat: 11–13 September 2026, six doses at 09:00/21:00.
    const items = collectReconciliationItems(
      baseInput({
        windows: [
          makeWindow({
            startsAt: '2026-09-11T15:30:00.000Z',
            endsAt: '2026-09-13T16:24:00.000Z',
            kind: 'combined',
            label: 'Shabbat · Rosh Hashana',
          }),
        ],
        nowMs: fromIso('2026-09-14T06:00:00.000Z'),
      }),
    );

    // Friday 21:00, Saturday 09:00 and 21:00, Sunday 09:00 — the whole span, not just the last
    // night. Sunday 21:00 falls after Havdalah (19:24 local) and is an ordinary weekday dose.
    expect(
      items.map((item) => `${item.occurrence.localDate} ${item.occurrence.scheduledLocalTime}`),
    ).toEqual(['2026-09-11 21:00', '2026-09-12 09:00', '2026-09-12 21:00', '2026-09-13 09:00']);
  });

  it('asks about a dose once even when a schedule was edited mid-window', () => {
    const items = collectReconciliationItems(
      baseInput({
        schedules: [makeSchedule(), makeSchedule({ id: 'schedule-1' })],
      }),
    );

    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });

  it('has nothing to say without any published windows', () => {
    expect(collectReconciliationItems(baseInput({ windows: [] }))).toEqual([]);
  });
});

describe('hasUnreconciledDoses', () => {
  it('is what makes motzei_pending a state the app can be in', () => {
    const items = collectReconciliationItems(baseInput());
    const config = makeConfig();
    const windows = [makeWindow()];

    expect(hasUnreconciledDoses(items)).toBe(true);
    expect(shabbatPhaseAt({ config, windows, atMs: AFTER, hasUnreconciledDoses: true })).toBe(
      'motzei_pending',
    );

    expect(hasUnreconciledDoses([])).toBe(false);
    expect(shabbatPhaseAt({ config, windows, atMs: AFTER, hasUnreconciledDoses: false })).toBe(
      'weekday',
    );
  });
});

describe('isReconcilableAt', () => {
  it('is false inside a window and true once it has ended', () => {
    const windows = [makeWindow()];

    expect(isReconcilableAt(windows, fromIso('2026-08-15T09:00:00.000Z'))).toBe(false);
    expect(isReconcilableAt(windows, AFTER)).toBe(true);
  });
});
