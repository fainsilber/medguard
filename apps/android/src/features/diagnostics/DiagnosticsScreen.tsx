import { resolveLocal, toIso } from '@medguard/shared';
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { cancelDoseAlarm, playTestChime, scheduleDoseAlarm } from '../../../modules/medguard-alarms/src';
import { AlarmSetupChecklist } from '../../alarms/AlarmSetupChecklist.js';
import { useRepository } from '../../app/RepositoryContext.js';
import {
  clearAppLog,
  exportAppLogText,
  getAppLogEntries,
  onAppLogChange,
} from '../../logging/appLog.js';
import { shareTextFile } from '../export/shareTextFile.js';
import { deviceClock, deviceIdGenerator } from '../../runtime/deviceRuntime.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import { useSyncStatus } from '../../sync/SyncProvider.js';
import { Button, Card, colors, styles as ui } from '../../ui/primitives.js';
import { APP_VERSION, BUILD_TIME, GIT_SHA, NATIVE_BUILD_VERSION } from '../../version.js';

const JERUSALEM = 'Asia/Jerusalem';

/**
 * The Android Diagnostics tab. Deliberately **not** a port of web's `probe/ProbePage.tsx` — that
 * screen tests Service Worker / Web Push reliability, none of which applies to a native app using
 * FCM (Sprint A4). This tab instead repurposes Sprint A0's `SpikeScreen` (the still-relevant
 * Hermes ICU check and alarm-permission/test-chime tooling — the native alarm layer needs the
 * same on-device verification regardless of which sprint built which screen) and adds what a
 * caregiver or developer actually needs to diagnose *this* app: live sync status, the pending-
 * outbox count, and the in-memory app log (`logging/appLog.ts`), exportable via the share sheet
 * for a bug report instead of a screenshot.
 */
export function DiagnosticsScreen(): React.JSX.Element {
  const repository = useRepository();
  const { status } = useSyncStatus();
  const pendingCount = useLiveQuery(() => repository.pendingSyncCount(), ['syncOutbox']);

  const [armedOccurrenceKey, setArmedOccurrenceKey] = useState<string | null>(null);
  const [status_, setStatusMessage] = useState('');

  const jerusalemDoseCheck = resolveLocal(JERUSALEM, '2026-01-15', '08:00');
  const jerusalemDoseIso = jerusalemDoseCheck.kind === 'exact' ? toIso(jerusalemDoseCheck.instantMs) : null;
  const icuLooksSane = jerusalemDoseIso === '2026-01-15T06:00:00.000Z';

  const onPlayTestChime = useCallback(() => {
    setStatusMessage('Playing test chime…');
    playTestChime(45).then(() => setStatusMessage('Test chime started — 45s, alarm stream, auto-stops.'));
  }, []);

  const onScheduleLockedPhoneAlarm = useCallback(() => {
    const occurrenceKey = deviceIdGenerator.next();
    const triggerAtMs = deviceClock.nowMs() + 15_000;
    setStatusMessage('Arming a real AlarmManager alarm for 15s from now. Lock the phone now.');
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
      setStatusMessage('Alarm cancelled.');
    });
  }, [armedOccurrenceKey]);

  const [logEntryCount, setLogEntryCount] = useState(() => getAppLogEntries().length);
  useEffect(() => onAppLogChange(() => setLogEntryCount(getAppLogEntries().length)), []);

  const onShareLog = useCallback(() => {
    // A generic `Share.share({ message })` text share leaves the OS to invent a filename (the
    // save-to-file targets in the share sheet fall back to something like "log08071452.txt", no
    // help when a caregiver is comparing a report to a bug that happened hours ago). Writing to a
    // real file first, the same way the CSV/backup exports already do via `shareTextFile`, lets
    // this name it explicitly — with the timestamp the moment it was shared, not when it's opened.
    const timestamp = deviceClock.nowIso().replace(/[:.]/g, '-');
    void shareTextFile(
      exportAppLogText() || 'MedGuard app log is empty.',
      `medguard-app-log-${timestamp}.txt`,
      'text/plain',
    ).catch((err) => {
      setStatusMessage(err instanceof Error ? err.message : 'Could not share the log file.');
    });
  }, []);

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.content}>
      <Text style={ui.title}>Diagnostics</Text>
      <Text style={ui.subtitle}>
        Device- and sync-level checks, not a port of the web app&rsquo;s push-testing screen — see
        the code comment in this file for why.
      </Text>

      <Card>
        <Text style={sectionTitle}>Build</Text>
        <Row label="Version" value={APP_VERSION} />
        <Row label="Git SHA" value={GIT_SHA} />
        <Row label="Built" value={BUILD_TIME ? new Date(BUILD_TIME).toLocaleString() : 'unknown'} />
        <Row label="Native build number" value={NATIVE_BUILD_VERSION ?? 'unknown'} />
      </Card>

      <Card>
        <Text style={sectionTitle}>Sync status</Text>
        <Row label="Status" value={status.kind} />
        <Row label="Pending outbox entries" value={pendingCount === undefined ? '…' : String(pendingCount)} />
        {status.kind === 'error' ? <Row label="Last error" value={status.message} warn /> : null}
      </Card>

      <Card>
        <Text style={sectionTitle}>AD1 — Hermes ICU</Text>
        <Row label="Asia/Jerusalem 08:00 → UTC" value={jerusalemDoseIso ?? 'failed to resolve'} />
        <Row label="Matches expected fixture" value={icuLooksSane ? 'yes' : 'NO — see AD1'} warn={!icuLooksSane} />
      </Card>

      <Card>
        <Text style={sectionTitle}>Alarm permissions</Text>
        <AlarmSetupChecklist />
      </Card>

      <Card>
        <Text style={sectionTitle}>The chime</Text>
        <Text style={ui.subtitle}>Fires immediately through the same DoseAlarmService a scheduled alarm uses.</Text>
        <Button label="Play test chime now (45s)" onPress={onPlayTestChime} />
      </Card>

      <Card>
        <Text style={sectionTitle}>Locked-phone dry run</Text>
        <Text style={ui.subtitle}>
          Arms a real AlarmManager.setAlarmClock() 15 seconds out. Lock the phone immediately after tapping.
        </Text>
        <Button label="Arm alarm in 15s" onPress={onScheduleLockedPhoneAlarm} disabled={armedOccurrenceKey != null} />
        {armedOccurrenceKey ? <Button label="Cancel" onPress={onCancelArmedAlarm} variant="danger" /> : null}
      </Card>

      <Card>
        <Text style={sectionTitle}>App log</Text>
        <Row label="Entries this session" value={String(logEntryCount)} />
        <View style={ui.row}>
          <Button label="Share log" onPress={onShareLog} />
          <Button label="Clear" onPress={clearAppLog} variant="danger" />
        </View>
      </Card>

      {status_ ? <Text style={{ fontSize: 13, color: colors.primary }}>{status_}</Text> : null}
    </ScrollView>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }): React.JSX.Element {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
      <Text style={{ fontSize: 14, color: colors.textMuted }}>{label}</Text>
      <Text style={{ fontSize: 14, fontWeight: '600', color: warn ? colors.locked : colors.text }}>{value}</Text>
    </View>
  );
}

const sectionTitle = { fontSize: 16, fontWeight: '600' as const, color: colors.text };
