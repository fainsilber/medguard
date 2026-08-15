import { describe, expect, it } from 'vitest';
import { diffAlarms } from './alarmReconciler.js';
import type { ArmedRecord } from './alarmReconciler.js';
import type { PlannedAlarm } from './horizon.js';

function planned(
  occurrenceKey: string,
  triggerAtMs: number,
  channelId: PlannedAlarm['channelId'] = 'dose_standard_v1',
  chimeDurationSeconds = 60,
): PlannedAlarm {
  return {
    occurrenceKey,
    triggerAtMs,
    title: 'Ondansetron is due',
    body: '1 dose · 12:00',
    channelId,
    chimeDurationSeconds,
    // The occurrence itself is irrelevant to the diff, which keys on identity, time and channel.
    occurrence: {} as PlannedAlarm['occurrence'],
  };
}

function armed(
  occurrenceKey: string,
  triggerAtMs: number,
  channelId = 'dose_standard_v1',
  chimeDurationSeconds = 60,
): ArmedRecord {
  return { occurrenceKey, triggerAtMs, channelId, chimeDurationSeconds };
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

  it('re-arms a dose whose channel changed — Shabbat began since it was armed', () => {
    // Same occurrence, same instant, different channel. Left alone it would ring on the weekday
    // channel, with the "Taken" and "Snooze" buttons Shabbat mode exists to avoid (delta D5).
    const diff = diffAlarms([armed('a', 1_000)], [planned('a', 1_000, 'shabbat_v1')]);

    expect(diff.toArm.map((alarm) => alarm.occurrenceKey)).toEqual(['a']);
    expect(diff.toCancel).toEqual([]);
  });

  it('leaves an alarm alone when its channel is unchanged', () => {
    const diff = diffAlarms([armed('a', 1_000, 'shabbat_v1')], [planned('a', 1_000, 'shabbat_v1')]);

    expect(diff.toArm).toEqual([]);
  });

  it('does not churn alarms armed by a build that never reported a channel', () => {
    // An upgrade path, not a Shabbat case: an older armed record has no channel to compare, and
    // re-arming every alarm on first launch after an update would flicker the system UI's
    // upcoming-alarm affordance for no benefit.
    const diff = diffAlarms([{ occurrenceKey: 'a', triggerAtMs: 1_000 }], [planned('a', 1_000)]);

    expect(diff.toArm).toEqual([]);
  });

  it('re-arms a dose whose alert length changed', () => {
    // The length rides inside the alarm payload, so an already-armed alarm keeps the old number
    // until it is re-armed — meaning editing the setting would appear to do nothing for as long
    // as the 48-hour horizon.
    const diff = diffAlarms([armed('a', 1_000)], [planned('a', 1_000, 'dose_standard_v1', 30)]);

    expect(diff.toArm.map((alarm) => alarm.occurrenceKey)).toEqual(['a']);
    expect(diff.toCancel).toEqual([]);
  });

  it('leaves an alarm alone when its alert length is unchanged', () => {
    const diff = diffAlarms(
      [armed('a', 1_000, 'shabbat_v1', 30)],
      [planned('a', 1_000, 'shabbat_v1', 30)],
    );

    expect(diff.toArm).toEqual([]);
  });

  it('does not churn alarms armed by a build that never reported an alert length', () => {
    const diff = diffAlarms(
      [{ occurrenceKey: 'a', triggerAtMs: 1_000, channelId: 'dose_standard_v1' }],
      [planned('a', 1_000)],
    );

    expect(diff.toArm).toEqual([]);
  });

  it('is a no-op on an empty device with nothing to do', () => {
    expect(diffAlarms([], [])).toEqual({ toArm: [], toCancel: [] });
  });
});
