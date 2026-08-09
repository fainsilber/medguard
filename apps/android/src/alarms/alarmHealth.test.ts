import { describe, expect, it } from 'vitest';
import { fromIso } from '@medguard/shared';
import {
  SYNC_STALE_AFTER_MS,
  deriveAlarmHealth,
  deriveSyncStaleness,
  describeAlarmStatus,
} from './alarmHealth.js';
import type { AlarmPermissions } from './alarmHealth.js';

const NOW = fromIso('2026-06-15T12:00:00.000Z');

const allGranted: AlarmPermissions = {
  canScheduleExactAlarms: true,
  hasNotificationPermission: true,
  isIgnoringBatteryOptimizations: true,
  hasNotificationPolicyAccess: true,
};

describe('deriveAlarmHealth', () => {
  it('reports a fully-permitted device as armed with no complaints', () => {
    expect(deriveAlarmHealth(allGranted, 4)).toEqual({
      blockers: [],
      risks: [],
      armedCount: 4,
      armed: true,
    });
  });

  it('treats a device with no upcoming doses as armed, not broken', () => {
    // Zero armed alarms is the normal state of a household between doses. Conflating it with
    // "alarms are not working" would cry wolf constantly.
    expect(deriveAlarmHealth(allGranted, 0).armed).toBe(true);
  });

  it('blocks when exact alarms are denied — nothing can be scheduled at all', () => {
    const health = deriveAlarmHealth({ ...allGranted, canScheduleExactAlarms: false }, 0);

    expect(health.blockers).toEqual(['exact_alarms_denied']);
    expect(health.armed).toBe(false);
  });

  it('blocks when notifications are denied — the chime has nothing to show', () => {
    const health = deriveAlarmHealth({ ...allGranted, hasNotificationPermission: false }, 0);

    expect(health.blockers).toEqual(['notifications_denied']);
    expect(health.armed).toBe(false);
  });

  it('reports both blockers when a device is fully locked down', () => {
    const health = deriveAlarmHealth(
      { ...allGranted, canScheduleExactAlarms: false, hasNotificationPermission: false },
      0,
    );

    expect(health.blockers).toEqual(['exact_alarms_denied', 'notifications_denied']);
  });

  it('treats battery optimisation as a risk, not a blocker', () => {
    // AD7: OEM battery managers cannot be granted programmatically, and alarms usually still
    // fire. Claiming failure would be as dishonest as claiming success.
    const health = deriveAlarmHealth({ ...allGranted, isIgnoringBatteryOptimizations: false }, 2);

    expect(health.risks).toEqual(['battery_optimized']);
    expect(health.blockers).toEqual([]);
    expect(health.armed).toBe(true);
  });

  it('treats a missing Do Not Disturb grant as a risk', () => {
    const health = deriveAlarmHealth({ ...allGranted, hasNotificationPolicyAccess: false }, 2);

    expect(health.risks).toEqual(['dnd_not_granted']);
    expect(health.armed).toBe(true);
  });
});

describe('deriveSyncStaleness', () => {
  it('treats a device that has never synced as stale', () => {
    // The state a half-completed household join leaves behind — and precisely when the local
    // data is emptiest, so it is the last thing that should look healthy.
    expect(deriveSyncStaleness(undefined, NOW)).toEqual({ stale: true, neverSynced: true });
  });

  it('is fresh just inside the threshold', () => {
    const lastSynced = '2026-06-14T12:00:00.000Z'; // exactly 24h
    expect(deriveSyncStaleness(lastSynced, NOW).stale).toBe(false);
  });

  it('is stale one millisecond past the threshold', () => {
    const staleness = deriveSyncStaleness('2026-06-14T11:59:59.999Z', NOW);

    expect(staleness.stale).toBe(true);
    expect(staleness.ageMs).toBe(SYNC_STALE_AFTER_MS + 1);
  });

  it('reports a recent sync as fresh, with its age', () => {
    const staleness = deriveSyncStaleness('2026-06-15T11:00:00.000Z', NOW);

    expect(staleness).toEqual({ stale: false, ageMs: 3_600_000, neverSynced: false });
  });

  it('does not call a future timestamp stale — clock trust is a different report', () => {
    // A negative age means skew or tampering. `localClockGuard` owns that story; saying "stale"
    // here would describe the same problem in a second, contradictory vocabulary.
    const staleness = deriveSyncStaleness('2026-06-16T12:00:00.000Z', NOW);

    expect(staleness.stale).toBe(false);
    expect(staleness.ageMs).toBeLessThan(0);
  });
});

describe('describeAlarmStatus', () => {
  const fresh = deriveSyncStaleness('2026-06-15T11:00:00.000Z', NOW);

  it('says nothing when everything is healthy', () => {
    expect(describeAlarmStatus(deriveAlarmHealth(allGranted, 3), fresh)).toBeUndefined();
  });

  it('leads with blockers, which outrank staleness', () => {
    const health = deriveAlarmHealth({ ...allGranted, canScheduleExactAlarms: false }, 0);
    const status = describeAlarmStatus(health, deriveSyncStaleness(undefined, NOW));

    expect(status?.title).toBe('MedGuard alarms are off');
    expect(status?.body).toContain('Exact alarms are not permitted');
  });

  it('explains every blocker, not just the first', () => {
    const health = deriveAlarmHealth(
      { ...allGranted, canScheduleExactAlarms: false, hasNotificationPermission: false },
      0,
    );

    const body = describeAlarmStatus(health, fresh)?.body ?? '';
    expect(body).toContain('Exact alarms are not permitted');
    expect(body).toContain('Notifications are turned off');
  });

  it('reports staleness with a concrete age, and says armed alarms still fire', () => {
    const status = describeAlarmStatus(
      deriveAlarmHealth(allGranted, 2),
      deriveSyncStaleness('2026-06-13T00:00:00.000Z', NOW),
    );

    expect(status?.title).toBe('MedGuard has not synced recently');
    expect(status?.body).toContain('60 hours ago');
    expect(status?.body).toContain('will still fire');
  });

  it('words a never-synced device differently from a long-ago one', () => {
    const status = describeAlarmStatus(
      deriveAlarmHealth(allGranted, 0),
      deriveSyncStaleness(undefined, NOW),
    );

    expect(status?.body).toContain('has not synced yet');
  });

  it('falls back to risks when nothing worse is wrong', () => {
    const health = deriveAlarmHealth(
      { ...allGranted, isIgnoringBatteryOptimizations: false, hasNotificationPolicyAccess: false },
      2,
    );

    const status = describeAlarmStatus(health, fresh);
    expect(status?.title).toBe('MedGuard alarms may be delayed');
    expect(status?.body).toContain('Battery optimisation');
    expect(status?.body).toContain('Do Not Disturb');
  });
});
