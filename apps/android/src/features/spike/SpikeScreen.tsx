import { resolveLocal, toIso } from '@medguard/shared';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  canScheduleExactAlarms,
  cancelDoseAlarm,
  isIgnoringBatteryOptimizations,
  playTestChime,
  requestIgnoreBatteryOptimizations,
  requestScheduleExactAlarm,
  scheduleDoseAlarm,
} from '../../../modules/medguard-alarms/src';
import { deviceClock, deviceIdGenerator } from '../../runtime/deviceRuntime';

const JERUSALEM = 'Asia/Jerusalem';

/**
 * Sprint A0's exit gate, as a screen: docs/android-client-plan.md says nothing else is built
 * until "the 45-second chime fires on a real, locked Android phone, at alarm volume, and
 * auto-stops, with zero touches" and the Asia/Jerusalem DST fixtures resolve correctly under
 * Hermes. This screen is how a human checks both, on a real device, from inside the app rather
 * than from a test runner.
 */
export function SpikeScreen(): React.JSX.Element {
  const [exactAlarmsArmed, setExactAlarmsArmed] = useState<boolean | null>(null);
  const [batteryExempt, setBatteryExempt] = useState<boolean | null>(null);
  const [armedOccurrenceKey, setArmedOccurrenceKey] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const refreshPermissionState = useCallback(() => {
    canScheduleExactAlarms().then(setExactAlarmsArmed);
    isIgnoringBatteryOptimizations().then(setBatteryExempt);
  }, []);

  useEffect(() => {
    refreshPermissionState();
  }, [refreshPermissionState]);

  // The ICU half of the A0 gate: a real dose-time resolution, computed on-device under
  // whichever ICU the installed Hermes build actually has, not asserted in a Node test.
  const jerusalemDoseCheck = resolveLocal(JERUSALEM, '2026-01-15', '08:00');
  const jerusalemDoseIso = jerusalemDoseCheck.kind === 'exact' ? toIso(jerusalemDoseCheck.instantMs) : null;
  const icuLooksSane = jerusalemDoseIso === '2026-01-15T06:00:00.000Z';

  const onPlayTestChime = useCallback(() => {
    setStatus('Playing test chime…');
    playTestChime(45).then(() => setStatus('Test chime started — 45s, alarm stream, auto-stops.'));
  }, []);

  const onScheduleLockedPhoneAlarm = useCallback(() => {
    const occurrenceKey = deviceIdGenerator.next();
    const triggerAtMs = deviceClock.nowMs() + 15_000;
    setStatus('Arming a real AlarmManager alarm for 15s from now. Lock the phone now.');
    scheduleDoseAlarm({
      occurrenceKey,
      triggerAtMs,
      channelId: 'dose_standard_v1',
      title: 'MedGuard — test dose',
      body: 'Locked-phone alarm spike (Sprint A0).',
      chimeDurationSeconds: 45,
      escalation: false,
    }).then(() => setArmedOccurrenceKey(occurrenceKey));
  }, []);

  const onCancelArmedAlarm = useCallback(() => {
    if (!armedOccurrenceKey) return;
    cancelDoseAlarm(armedOccurrenceKey).then(() => {
      setArmedOccurrenceKey(null);
      setStatus('Alarm cancelled.');
    });
  }, [armedOccurrenceKey]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>MedGuard — A0 spike</Text>
      <Text style={styles.subtitle}>Nothing else gets built until this gate passes.</Text>

      <Section title="AD1 — Hermes ICU">
        <Row label="Asia/Jerusalem 08:00 → UTC" value={jerusalemDoseIso ?? 'failed to resolve'} />
        <Row label="Matches expected fixture" value={icuLooksSane ? 'yes' : 'NO — see AD1'} warn={!icuLooksSane} />
      </Section>

      <Section title="Alarm permissions">
        <Row label="Exact alarms armed" value={formatBool(exactAlarmsArmed)} warn={exactAlarmsArmed === false} />
        {exactAlarmsArmed === false ? (
          <Button label="Grant exact-alarm permission" onPress={() => requestScheduleExactAlarm()} />
        ) : null}
        <Row label="Battery-optimization exempt" value={formatBool(batteryExempt)} warn={batteryExempt === false} />
        {batteryExempt === false ? (
          <Button label="Request battery exemption" onPress={() => requestIgnoreBatteryOptimizations()} />
        ) : null}
      </Section>

      <Section title="The chime">
        <Text style={styles.hint}>Fires immediately through the same DoseAlarmService a scheduled alarm uses.</Text>
        <Button label="Play test chime now (45s)" onPress={onPlayTestChime} />
      </Section>

      <Section title="Locked-phone dry run">
        <Text style={styles.hint}>
          Arms a real AlarmManager.setAlarmClock() 15 seconds out. Lock the phone immediately after tapping.
        </Text>
        <Button label="Arm alarm in 15s" onPress={onScheduleLockedPhoneAlarm} disabled={armedOccurrenceKey != null} />
        {armedOccurrenceKey ? <Button label="Cancel" onPress={onCancelArmedAlarm} /> : null}
      </Section>

      {status ? <Text style={styles.status}>{status}</Text> : null}
    </ScrollView>
  );
}

function formatBool(value: boolean | null): string {
  if (value === null) return 'checking…';
  return value ? 'yes' : 'no';
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, warn ? styles.warn : null]}>{value}</Text>
    </View>
  );
}

function Button({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.button, disabled ? styles.buttonDisabled : null, pressed ? styles.buttonPressed : null]}
    >
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 16 },
  title: { fontSize: 22, fontWeight: '700' },
  subtitle: { fontSize: 14, color: '#555', marginBottom: 8 },
  section: { gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#ccc', paddingTop: 12 },
  sectionTitle: { fontSize: 16, fontWeight: '600' },
  hint: { fontSize: 13, color: '#555' },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { fontSize: 14 },
  rowValue: { fontSize: 14, fontWeight: '600' },
  warn: { color: '#B3261E' },
  button: { backgroundColor: '#1B4332', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14, alignItems: 'center' },
  buttonPressed: { opacity: 0.8 },
  buttonDisabled: { backgroundColor: '#999' },
  buttonLabel: { color: 'white', fontWeight: '600' },
  status: { fontSize: 13, color: '#1B4332', marginTop: 8 },
});
