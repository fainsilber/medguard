import { MS_PER_HOUR, fromIso } from '@medguard/shared';
import type { EpochMs, IsoInstant } from '@medguard/shared';

/**
 * Whether this device can actually do the one thing it exists to do, and whether the data it
 * would do it from is current.
 *
 * Safety invariant 6: *if sync is stale, alarms are unarmed, or clock skew is detected, the UI
 * says so loudly.* Both states here are silent by nature — a battery manager revoking exact
 * alarms, or a phone quietly failing to reach the server for a day, look exactly like a working
 * app until a dose is missed. Pure functions so the wording and thresholds are testable without a
 * device.
 */

/**
 * Past this, the local data alarms are armed from is old enough that a schedule change made on
 * another device could plausibly have been missed. Alarms already armed keep firing — the app
 * just stops claiming they are authoritative (docs/android-client-plan.md, "When local data is
 * stale").
 */
export const SYNC_STALE_AFTER_MS = 24 * MS_PER_HOUR;

/**
 * Hard stops. With either of these, no local alarm can fire at all — not "may not", *will not*.
 */
export type AlarmBlocker =
  /** `AlarmManager.canScheduleExactAlarms()` is false: nothing can be armed. */
  | 'exact_alarms_denied'
  /** POST_NOTIFICATIONS refused: the chime's foreground service cannot show its notification. */
  | 'notifications_denied';

/**
 * Degradations. Alarms are armed and will usually fire, but the OS may interfere. Kept distinct
 * from blockers because AD7 is explicit that these cannot be fixed programmatically — claiming
 * failure would be as dishonest as claiming success.
 */
export type AlarmRisk =
  /** Not exempt from battery optimisation: OEM managers may delay or drop the alarm. */
  | 'battery_optimized'
  /** No notification-policy access: Do Not Disturb will silence an escalation. */
  | 'dnd_not_granted'
  /**
   * Sprint A4: this device has no push registration, so the server's backstop cannot reach it.
   *
   * A risk rather than a blocker, and deliberately so: local alarms are primary and unaffected.
   * What is lost is the cover for everything local alarms cannot do — firing when this device's
   * own alarms have been suppressed, and above all receiving an *escalation*, which only the
   * server can decide to send because only it knows whether another caregiver responded.
   */
  | 'no_server_backstop';

export interface AlarmPermissions {
  canScheduleExactAlarms: boolean;
  hasNotificationPermission: boolean;
  isIgnoringBatteryOptimizations: boolean;
  hasNotificationPolicyAccess: boolean;
  /**
   * Whether the server can reach this device by push (Sprint A4). Optional so a caller that has
   * not looked yet reads as "no reason to worry" rather than raising a false alarm on every
   * start — the registration is asynchronous and usually completes moments later.
   */
  hasPushRegistration?: boolean;
}

export interface AlarmHealth {
  blockers: AlarmBlocker[];
  risks: AlarmRisk[];
  /** How many alarms are armed right now — 0 with no blockers just means nothing is due soon. */
  armedCount: number;
  /** True when nothing prevents an alarm firing. Risks do not clear this; blockers do. */
  armed: boolean;
}

export function deriveAlarmHealth(
  permissions: AlarmPermissions,
  armedCount: number,
): AlarmHealth {
  const blockers: AlarmBlocker[] = [];
  if (!permissions.canScheduleExactAlarms) {
    blockers.push('exact_alarms_denied');
  }
  if (!permissions.hasNotificationPermission) {
    blockers.push('notifications_denied');
  }

  const risks: AlarmRisk[] = [];
  if (!permissions.isIgnoringBatteryOptimizations) {
    risks.push('battery_optimized');
  }
  if (!permissions.hasNotificationPolicyAccess) {
    risks.push('dnd_not_granted');
  }
  if (permissions.hasPushRegistration === false) {
    risks.push('no_server_backstop');
  }

  return { blockers, risks, armedCount, armed: blockers.length === 0 };
}

export interface SyncStaleness {
  stale: boolean;
  /** Absent when this device has never completed a pull. */
  ageMs?: number;
  /** True before any successful sync — distinct from "synced, but long ago". */
  neverSynced: boolean;
}

/**
 * A device that has never synced is treated as stale, not as fresh. It is the state a half-
 * completed household join leaves behind, and it is precisely when the local data is emptiest.
 *
 * A last-sync instant in the future (a caregiver winding the clock back, or skew against the
 * device that wrote it) yields a negative age, which is not stale — the clock-trust guard in
 * `src/clock/localClockGuard.ts` is what reports tampering, and reporting it twice in two
 * different vocabularies would be worse than reporting it once.
 */
export function deriveSyncStaleness(
  lastSyncedAt: IsoInstant | undefined,
  nowMs: EpochMs,
): SyncStaleness {
  if (lastSyncedAt === undefined) {
    return { stale: true, neverSynced: true };
  }

  const ageMs = nowMs - fromIso(lastSyncedAt);
  return { stale: ageMs > SYNC_STALE_AFTER_MS, ageMs, neverSynced: false };
}

const RISK_WORDING: Record<AlarmRisk, string> = {
  battery_optimized: 'Battery optimisation is on for MedGuard, which can delay or drop alarms.',
  dnd_not_granted: 'Do Not Disturb access has not been granted, so an escalation may be silenced.',
  no_server_backstop:
    'This device is not registered for server alerts, so it will not receive an escalation if a dose goes unconfirmed.',
};

/**
 * The text of the ongoing `sync_status_v1` notification, or `undefined` when there is nothing
 * wrong and the notification should be cleared.
 *
 * Blockers outrank staleness: "alarms will not fire" is a more urgent thing to read on a lock
 * screen than "this data is a day old", and a caregiver glancing at the shade should get the
 * worse news first.
 */
export function describeAlarmStatus(
  health: AlarmHealth,
  staleness: SyncStaleness,
): { title: string; body: string } | undefined {
  if (health.blockers.length > 0) {
    return {
      title: 'MedGuard alarms are off',
      body: health.blockers
        .map((blocker) =>
          blocker === 'exact_alarms_denied'
            ? 'Exact alarms are not permitted, so no dose alarm can be scheduled.'
            : 'Notifications are turned off, so dose alarms cannot be shown.',
        )
        .join(' '),
    };
  }

  if (staleness.stale) {
    return {
      title: 'MedGuard has not synced recently',
      body: staleness.neverSynced
        ? 'This device has not synced yet, so it may not know about all scheduled doses.'
        : `Last synced over ${Math.floor((staleness.ageMs ?? 0) / MS_PER_HOUR)} hours ago. Alarms already set will still fire, but a schedule change made elsewhere may be missing.`,
    };
  }

  if (health.risks.length > 0) {
    return {
      title: 'MedGuard alarms may be delayed',
      body: health.risks
        .map((risk) => RISK_WORDING[risk])
        .join(' '),
    };
  }

  return undefined;
}
