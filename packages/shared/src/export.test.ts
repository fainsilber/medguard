import { describe, expect, it } from 'vitest';
import { buildIntakeLogCsv } from './export.js';
import type { IntakeLog } from './types.js';

const TIME_ZONE = 'UTC';

function log(id: string, overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id,
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    type: 'prn',
    status: 'taken',
    actualTime: '2026-06-15T12:00:00.000Z',
    quantityTaken: 1,
    loggedByUserId: 'Mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

const MEDICINE_NAMES = new Map([['medicine-1', 'Ondansetron 4mg']]);

describe('buildIntakeLogCsv', () => {
  it('emits just the header when there are no logs', () => {
    expect(buildIntakeLogCsv([], MEDICINE_NAMES, TIME_ZONE)).toBe(
      'Date,Scheduled time,Time given,Medicine,Type,Status,Quantity,Given by,Override reason,Notes\r\n',
    );
  });

  it('emits one row per log, oldest first, with human-readable columns', () => {
    const logs = [
      log('later', { actualTime: '2026-06-15T20:00:00.000Z', type: 'scheduled', status: 'skipped', quantityTaken: 0 }),
      log('earlier', { actualTime: '2026-06-15T08:00:00.000Z' }),
    ];

    const csv = buildIntakeLogCsv(logs, MEDICINE_NAMES, TIME_ZONE);
    const lines = csv.trim().split('\r\n');

    expect(lines).toEqual([
      'Date,Scheduled time,Time given,Medicine,Type,Status,Quantity,Given by,Override reason,Notes',
      '2026-06-15,,08:00,Ondansetron 4mg,As needed,Taken,1,Mom,,',
      '2026-06-15,,20:00,Ondansetron 4mg,Scheduled,Skipped,0,Mom,,',
    ]);
  });

  it('records the scheduled time alongside the time actually given, when they differ', () => {
    const logs = [
      log('late', {
        type: 'scheduled',
        scheduledTime: '2026-06-15T08:00:00.000Z',
        actualTime: '2026-06-15T09:15:00.000Z',
      }),
    ];

    const csv = buildIntakeLogCsv(logs, MEDICINE_NAMES, TIME_ZONE);
    expect(csv).toContain('2026-06-15,08:00,09:15,Ondansetron 4mg,Scheduled,Taken,1,Mom,,');
  });

  it('leaves the scheduled-time column blank for an as-needed dose, which has no due time', () => {
    const csv = buildIntakeLogCsv([log('prn', { type: 'prn' })], MEDICINE_NAMES, TIME_ZONE);
    expect(csv).toContain('2026-06-15,,12:00,');
  });

  it('excludes a log that a correction superseded, but includes the correction', () => {
    const logs = [
      log('mistake', { quantityTaken: 2 }),
      log('fix', { supersedesId: 'mistake', quantityTaken: 1, notes: 'Actually only half' }),
    ];

    const csv = buildIntakeLogCsv(logs, MEDICINE_NAMES, TIME_ZONE);

    expect(csv).not.toContain(',2,');
    expect(csv).toContain(',1,Mom,,Actually only half');
  });

  it('shows the override reason when a dose was recorded despite a safety block', () => {
    const logs = [
      log('override', {
        override: { confirmedByUserId: 'Dad', reason: 'Past due for relief', blockedBy: 'cooldown' },
      }),
    ];

    const csv = buildIntakeLogCsv(logs, MEDICINE_NAMES, TIME_ZONE);
    expect(csv).toContain(',Mom,Past due for relief,');
  });

  it('falls back to a placeholder name for a medicine id it does not recognise', () => {
    const csv = buildIntakeLogCsv([log('a')], new Map(), TIME_ZONE);
    expect(csv).toContain('Unknown medicine');
  });

  it('quotes a field that contains a comma, quote, or newline, per RFC 4180', () => {
    const csv = buildIntakeLogCsv([log('a', { notes: 'Gave with food, "just in case"' })], MEDICINE_NAMES, TIME_ZONE);
    expect(csv).toContain('"Gave with food, ""just in case"""');
  });

  it('labels every status the schema allows', () => {
    const logs = [
      log('taken', { status: 'taken' }),
      log('skipped', { status: 'skipped' }),
      log('missed', { status: 'missed' }),
      log('shabbat', { status: 'pending_shabbat' }),
    ];

    const csv = buildIntakeLogCsv(logs, MEDICINE_NAMES, TIME_ZONE);
    expect(csv).toContain(',Taken,');
    expect(csv).toContain(',Skipped,');
    expect(csv).toContain(',Missed,');
    expect(csv).toContain(',Pending (Shabbat),');
  });
});
