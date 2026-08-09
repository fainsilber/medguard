import { describe, expect, it } from 'vitest';
import { diffAlarms } from './alarmReconciler.js';
import type { ArmedRecord } from './alarmReconciler.js';
import type { PlannedAlarm } from './horizon.js';

function planned(occurrenceKey: string, triggerAtMs: number): PlannedAlarm {
  return {
    occurrenceKey,
    triggerAtMs,
    title: 'Ondansetron is due',
    body: '1 dose · 12:00',
    // The occurrence itself is irrelevant to the diff, which keys purely on identity and time.
    occurrence: {} as PlannedAlarm['occurrence'],
  };
}

function armed(occurrenceKey: string, triggerAtMs: number): ArmedRecord {
  return { occurrenceKey, triggerAtMs };
}

describe('diffAlarms', () => {
  it('arms everything on a device with nothing armed yet', () => {
    const diff = diffAlarms([], [planned('a', 1_000), planned('b', 2_000)]);

    expect(diff.toArm.map((alarm) => alarm.occurrenceKey)).toEqual(['a', 'b']);
    expect(diff.toCancel).toEqual([]);
  });

  it('leaves an unchanged alarm alone', () => {
    // Re-arming churns the system UI's upcoming-alarm affordance and briefly replaces the
    // PendingIntent, so an unchanged alarm must genuinely be a no-op.
    const diff = diffAlarms([armed('a', 1_000)], [planned('a', 1_000)]);

    expect(diff.toArm).toEqual([]);
    expect(diff.toCancel).toEqual([]);
  });

  it('re-arms an alarm whose trigger moved — the snooze and schedule-edit path', () => {
    const diff = diffAlarms([armed('a', 1_000)], [planned('a', 2_200)]);

    expect(diff.toArm.map((alarm) => alarm.triggerAtMs)).toEqual([2_200]);
    expect(diff.toCancel).toEqual([]);
  });

  it('cancels an alarm that is no longer planned — the dose was logged', () => {
    const diff = diffAlarms([armed('a', 1_000), armed('b', 2_000)], [planned('b', 2_000)]);

    expect(diff.toArm).toEqual([]);
    expect(diff.toCancel).toEqual(['a']);
  });

  it('cancels everything when nothing is planned', () => {
    const diff = diffAlarms([armed('a', 1_000), armed('b', 2_000)], []);

    expect(diff.toCancel).toEqual(['a', 'b']);
  });

  it('handles an arm, a cancel and a move in one pass', () => {
    const diff = diffAlarms(
      [armed('stays', 1_000), armed('moves', 2_000), armed('goes', 3_000)],
      [planned('stays', 1_000), planned('moves', 2_500), planned('new', 4_000)],
    );

    expect(diff.toArm.map((alarm) => alarm.occurrenceKey).sort()).toEqual(['moves', 'new']);
    expect(diff.toCancel).toEqual(['goes']);
  });

  it('is a no-op on an empty device with nothing to do', () => {
    expect(diffAlarms([], [])).toEqual({ toArm: [], toCancel: [] });
  });
});
