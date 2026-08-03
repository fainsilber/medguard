import { describe, expect, it } from 'vitest';
import {
  administeredDoses,
  effectiveLogs,
  lastAdministeredDose,
  sortByActualTimeDesc,
} from './logs.js';
import type { IntakeLog } from './types.js';

function log(id: string, overrides: Partial<IntakeLog> = {}): IntakeLog {
  return {
    id,
    patientId: 'patient-1',
    medicineId: 'medicine-1',
    type: 'prn',
    status: 'taken',
    actualTime: '2026-06-15T12:00:00.000Z',
    quantityTaken: 1,
    loggedByUserId: 'mom',
    loggedByDeviceId: 'device-1',
    syncStatus: 'synced',
    ...overrides,
  };
}

describe('effectiveLogs', () => {
  it('returns everything when nothing has been corrected', () => {
    const logs = [log('a'), log('b')];
    expect(effectiveLogs(logs).map((l) => l.id)).toEqual(['a', 'b']);
  });

  it('drops a log that a correction superseded', () => {
    const logs = [log('mistake'), log('fix', { supersedesId: 'mistake' })];
    expect(effectiveLogs(logs).map((l) => l.id)).toEqual(['fix']);
  });

  it('keeps only the tip of a correction chain', () => {
    const logs = [
      log('first'),
      log('second', { supersedesId: 'first' }),
      log('third', { supersedesId: 'second' }),
    ];
    expect(effectiveLogs(logs).map((l) => l.id)).toEqual(['third']);
  });

  it('does not depend on the order corrections arrive in', () => {
    // Sync can deliver a correction before the log it corrects.
    const logs = [log('fix', { supersedesId: 'mistake' }), log('mistake')];
    expect(effectiveLogs(logs).map((l) => l.id)).toEqual(['fix']);
  });

  it('handles independent corrections to different logs', () => {
    const logs = [
      log('a'),
      log('b'),
      log('fix-a', { supersedesId: 'a' }),
      log('fix-b', { supersedesId: 'b' }),
    ];
    expect(effectiveLogs(logs).map((l) => l.id).sort()).toEqual(['fix-a', 'fix-b']);
  });

  it('is empty for no logs', () => {
    expect(effectiveLogs([])).toEqual([]);
  });
});

describe('administeredDoses', () => {
  it('keeps only doses actually given', () => {
    const logs = [
      log('taken'),
      log('skipped', { status: 'skipped' }),
      log('missed', { status: 'missed' }),
      log('pending', { status: 'pending_shabbat' }),
    ];
    expect(administeredDoses(logs, 'medicine-1').map((l) => l.id)).toEqual(['taken']);
  });

  it('filters by medicine', () => {
    const logs = [log('mine'), log('theirs', { medicineId: 'other' })];
    expect(administeredDoses(logs, 'medicine-1').map((l) => l.id)).toEqual(['mine']);
  });

  it('excludes superseded doses', () => {
    const logs = [log('mistake'), log('fix', { supersedesId: 'mistake', status: 'skipped' })];
    // The correction says it was skipped after all, so nothing was administered.
    expect(administeredDoses(logs, 'medicine-1')).toEqual([]);
  });
});

describe('sortByActualTimeDesc', () => {
  it('orders most recent first', () => {
    const logs = [
      log('mid', { actualTime: '2026-06-15T11:00:00.000Z' }),
      log('old', { actualTime: '2026-06-15T09:00:00.000Z' }),
      log('new', { actualTime: '2026-06-15T13:00:00.000Z' }),
    ];
    expect(sortByActualTimeDesc(logs).map((l) => l.id)).toEqual(['new', 'mid', 'old']);
  });

  it('does not mutate its input', () => {
    const logs = [
      log('a', { actualTime: '2026-06-15T09:00:00.000Z' }),
      log('b', { actualTime: '2026-06-15T13:00:00.000Z' }),
    ];
    sortByActualTimeDesc(logs);
    expect(logs.map((l) => l.id)).toEqual(['a', 'b']);
  });
});

describe('lastAdministeredDose', () => {
  it('finds the most recently administered dose', () => {
    const logs = [
      log('old', { actualTime: '2026-06-15T09:00:00.000Z' }),
      log('new', { actualTime: '2026-06-15T13:00:00.000Z', loggedByUserId: 'dad' }),
    ];
    expect(lastAdministeredDose(logs, 'medicine-1')?.loggedByUserId).toBe('dad');
  });

  it('goes by when the dose was given, not when it was recorded', () => {
    // A Shabbat dose is logged during Motzei Shabbat reconciliation, hours after the fact —
    // insertion order would name the wrong dose as most recent.
    const logs = [
      log('logged-later-given-earlier', { actualTime: '2026-06-15T09:00:00.000Z' }),
      log('logged-first-given-later', { actualTime: '2026-06-15T13:00:00.000Z' }),
    ];
    expect(lastAdministeredDose(logs, 'medicine-1')?.id).toBe('logged-first-given-later');
  });

  it('ignores skipped doses', () => {
    const logs = [
      log('taken', { actualTime: '2026-06-15T09:00:00.000Z' }),
      log('skipped', { actualTime: '2026-06-15T13:00:00.000Z', status: 'skipped' }),
    ];
    expect(lastAdministeredDose(logs, 'medicine-1')?.id).toBe('taken');
  });

  it('is undefined when nothing has been administered', () => {
    expect(lastAdministeredDose([], 'medicine-1')).toBeUndefined();
    expect(lastAdministeredDose([log('s', { status: 'skipped' })], 'medicine-1')).toBeUndefined();
  });
});
