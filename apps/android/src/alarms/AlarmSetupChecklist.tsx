import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import {
  canScheduleExactAlarms,
  hasNotificationPermission,
  hasNotificationPolicyAccess,
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
  requestNotificationPermission,
  requestNotificationPolicyAccess,
  requestScheduleExactAlarm,
} from '../../modules/medguard-alarms/src';
import { Button, colors } from '../ui/primitives.js';
import { useAlarmHealth } from './AlarmProvider.js';
import type { PushRegistrationOutcome } from './pushRegistration.js';

/**
 * The guided setup checklist AD7 owes: everything a caregiver can grant, plus an honest statement
 * of the one category of thing they cannot — an OEM autostart manager (Xiaomi, Huawei, Oppo,
 * Samsung) has no API to request through, so the checklist says so rather than pretending a
 * button could fix it.
 *
 * Shared between `DiagnosticsScreen` (always visible, for a caregiver or developer checking
 * proactively) and `AlarmHealthBanner` (surfaced reactively, only when something is actually
 * wrong) — one component rather than two copies of four permission rows.
 *
 * Reads the four OS permission rows directly from the native module rather than through
 * `useAlarmHealth()`, so a caregiver mid-fix sees each grant land immediately rather than waiting
 * for the next `AlarmEngine.reconcile()` pass to notice. The "Server alerts" row is the exception:
 * push registration isn't a native permission, it's a network call, so it reads and retries
 * through `useAlarmHealth()`'s `pushRegistration`/`retryPushRegistration`.
 */
export function AlarmSetupChecklist(): React.JSX.Element {
  const [exactAlarmsArmed, setExactAlarmsArmed] = useState<boolean | null>(null);
  const [batteryExempt, setBatteryExempt] = useState<boolean | null>(null);
  const [notificationsGranted, setNotificationsGranted] = useState<boolean | null>(null);
  const [dndBypassGranted, setDndBypassGranted] = useState<boolean | null>(null);
  const { pushRegistration, retryPushRegistration } = useAlarmHealth();

  const refresh = useCallback(() => {
    canScheduleExactAlarms().then(setExactAlarmsArmed);
    isIgnoringBatteryOptimizations().then(setBatteryExempt);
    hasNotificationPermission().then(setNotificationsGranted);
    hasNotificationPolicyAccess().then(setDndBypassGranted);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onRequestNotificationPermission = useCallback(() => {
    void requestNotificationPermission().then(refresh);
  }, [refresh]);

  const onRequestExactAlarm = useCallback(() => {
    void requestScheduleExactAlarm().then(refresh);
  }, [refresh]);

  const onRequestBatteryExemption = useCallback(() => {
    void requestIgnoreBatteryOptimizations().then(refresh);
  }, [refresh]);

  const onRequestDndAccess = useCallback(() => {
    void requestNotificationPolicyAccess().then(refresh);
  }, [refresh]);

  return (
    <View style={{ gap: 10 }}>
      <ChecklistRow
        label="Exact alarms"
        granted={exactAlarmsArmed}
        detail="Required for any dose alarm to fire at all."
        onRequest={onRequestExactAlarm}
        actionLabel="Grant"
      />
      <ChecklistRow
        label="Notifications"
        granted={notificationsGranted}
        detail="Without this, a firing alarm has nothing to show."
        onRequest={onRequestNotificationPermission}
        actionLabel="Grant"
      />
      <ChecklistRow
        label="Battery-optimization exemption"
        granted={batteryExempt}
        detail="Some phones delay or drop alarms from apps that aren't exempt."
        onRequest={onRequestBatteryExemption}
        actionLabel="Request"
      />
      <ChecklistRow
        label="Do Not Disturb access"
        granted={dndBypassGranted}
        detail="Needed so an escalation can be heard even in Do Not Disturb."
        onRequest={onRequestDndAccess}
        actionLabel="Grant"
      />
      <ChecklistRow
        label="Server alerts"
        granted={pushRegistration === undefined ? null : pushRegistration.kind === 'registered'}
        detail={describePushRegistration(pushRegistration)}
        onRequest={() => void retryPushRegistration()}
        actionLabel="Retry"
        statusLabels={{ granted: 'registered', notGranted: 'not registered' }}
      />

      <View style={{ gap: 4, paddingTop: 4 }}>
        <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>
          One more thing on some phones
        </Text>
        <Text style={{ fontSize: 12, color: colors.textMuted }}>
          Xiaomi, Huawei, Oppo and Samsung all ship their own battery managers with an
          &ldquo;autostart&rdquo; or &ldquo;protected apps&rdquo; list that Android has no way to
          grant on an app&rsquo;s behalf. If alarms still don&rsquo;t fire reliably after granting
          everything above, look for MedGuard in that phone&rsquo;s own battery or security app
          and allow it to autostart / run in the background.
        </Text>
      </View>
    </View>
  );
}

function ChecklistRow({
  label,
  granted,
  detail,
  onRequest,
  actionLabel,
  statusLabels = { granted: 'granted', notGranted: 'not granted' },
}: {
  label: string;
  granted: boolean | null;
  detail: string;
  onRequest: () => void;
  actionLabel: string;
  statusLabels?: { granted: string; notGranted: string };
}): React.JSX.Element {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Text style={{ fontSize: 14, color: colors.text }}>{label}</Text>
        <Text
          style={{
            fontSize: 13,
            fontWeight: '600',
            color: granted === false ? colors.locked : granted === true ? colors.safe : colors.textMuted,
          }}
        >
          {granted === null ? 'checking…' : granted ? statusLabels.granted : statusLabels.notGranted}
        </Text>
      </View>
      <Text style={{ fontSize: 12, color: colors.textMuted }}>{detail}</Text>
      {granted === false ? <Button label={actionLabel} onPress={onRequest} /> : null}
    </View>
  );
}

/** Wording for the "Server alerts" row — mirrors `RISK_WORDING.no_server_backstop` in tone. */
function describePushRegistration(outcome: PushRegistrationOutcome | undefined): string {
  if (!outcome) {
    return 'Lets the server send an escalation to this device if a dose goes unconfirmed.';
  }
  switch (outcome.kind) {
    case 'registered':
      return 'This device will receive an escalation from the server if a dose goes unconfirmed.';
    case 'no_token':
      return 'No push token yet — this build may have no Firebase project configured, or Firebase has not issued one yet.';
    case 'failed':
      return `Registration failed: ${outcome.error}`;
  }
}
