import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { buildIntakeLogCsv, effectiveLogs, formatLocalDate, formatLocalTime, fromIso } from '@medguard/shared';
import type { IntakeLog, Medicine } from '@medguard/shared';
import { useClock, useStore } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import { Button, Card, KeyboardAvoidingScreen, colors, styles as sharedStyles } from '../../ui/primitives.js';
import { BackupRestoreCard } from './BackupRestoreCard.js';
import { shareTextFile } from './shareTextFile.js';

/**
 * PRD Sprint 2 — "the app is a helper, not the only record". RN port of
 * `apps/web/src/features/export/ExportScreen.tsx`: a CSV for a spreadsheet, in case the app is
 * ever unavailable.
 *
 * Web also offers "Print summary" via `window.print()`; there is no Android equivalent (no
 * printer to print to from a share sheet in the general case), so that button is dropped rather
 * than faked. The on-screen log table survives, unstyled for print since there is nothing here to
 * print — it is still useful to scroll through on-device.
 */
export function ExportScreen(): React.JSX.Element {
  const store = useStore();
  const clock = useClock();
  const householdSettings = useHouseholdSettings();

  const medicines = useLiveQuery(
    () => store.transaction(['medicines'], (tx) => tx.getAll<Medicine>('medicines')),
    ['medicines'],
  );
  const logs = useLiveQuery(
    () => store.transaction(['intakeLogs'], (tx) => tx.getAll<IntakeLog>('intakeLogs')),
    ['intakeLogs'],
  );

  const medicineNames = useMemo(
    () =>
      new Map(
        (medicines ?? []).map((medicine) => [medicine.id, `${medicine.name} ${medicine.strength}`]),
      ),
    [medicines],
  );

  const rows = useMemo(() => {
    if (!logs) return undefined;
    return [...effectiveLogs(logs)].sort((a, b) => fromIso(a.actualTime) - fromIso(b.actualTime));
  }, [logs]);

  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);

  if (!medicines || !logs || !householdSettings || !rows) {
    return (
      <View style={sharedStyles.screen}>
        <View style={sharedStyles.content}>
          <Card>
            <Text style={sharedStyles.subtitle}>Loading…</Text>
          </Card>
        </View>
      </View>
    );
  }

  const timeZone = householdSettings.timeZone;
  const generatedOn = formatLocalDate(timeZone, clock.nowMs());
  const isEmpty = rows.length === 0;

  const handleShareCsv = async () => {
    setShareError(null);
    setSharing(true);
    try {
      await shareTextFile(
        buildIntakeLogCsv(logs, medicineNames, timeZone),
        `medguard-log-${generatedOn}.csv`,
        'text/csv',
      );
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Could not share the CSV file.');
    } finally {
      setSharing(false);
    }
  };

  return (
    <KeyboardAvoidingScreen>
      <ScrollView
        style={sharedStyles.screen}
        contentContainerStyle={sharedStyles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          <Text style={sharedStyles.title}>Export</Text>
          <Text style={sharedStyles.subtitle}>
            Keep a CSV copy for hospital visits — this app is a helper, not the only record.
          </Text>
          <Button
            label={sharing ? 'Sharing…' : 'Share CSV'}
            onPress={() => void handleShareCsv()}
            disabled={isEmpty || sharing}
            variant="primary"
          />
          {shareError && (
            <Text style={sharedStyles.errorText} accessibilityRole="alert">
              {shareError}
            </Text>
          )}
        </Card>

        <Card>
          <Text style={sharedStyles.title}>Medication log</Text>
          <Text style={sharedStyles.subtitle}>
            Generated {generatedOn} · {timeZone}
          </Text>

          {isEmpty ? (
            <Text style={sharedStyles.subtitle}>No doses logged yet.</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View>
                <View style={tableStyles.headerRow}>
                  {TABLE_COLUMNS.map((heading) => (
                    <Text key={heading} style={tableStyles.headerCell}>
                      {heading}
                    </Text>
                  ))}
                </View>
                {rows.map((log) => (
                  <View key={log.id} style={tableStyles.row}>
                    <Text style={tableStyles.cell}>{formatLocalDate(timeZone, fromIso(log.actualTime))}</Text>
                    <Text style={[tableStyles.cell, tableStyles.muted]}>
                      {log.scheduledTime === undefined
                        ? '—'
                        : formatLocalTime(timeZone, fromIso(log.scheduledTime))}
                    </Text>
                    <Text style={tableStyles.cell}>{formatLocalTime(timeZone, fromIso(log.actualTime))}</Text>
                    <Text style={[tableStyles.cell, tableStyles.wide]}>
                      {medicineNames.get(log.medicineId) ?? 'Unknown medicine'}
                    </Text>
                    <Text style={tableStyles.cell}>{log.status === 'taken' ? 'Taken' : 'Skipped'}</Text>
                    <Text style={tableStyles.cell}>{log.quantityTaken}</Text>
                    <Text style={tableStyles.cell}>{log.loggedByUserId}</Text>
                    <Text style={[tableStyles.cell, tableStyles.wide, tableStyles.muted]}>
                      {log.override
                        ? `Override (${log.override.blockedBy}): ${log.override.reason}`
                        : (log.notes ?? '')}
                    </Text>
                  </View>
                ))}
              </View>
            </ScrollView>
          )}
        </Card>

        <BackupRestoreCard />
      </ScrollView>
    </KeyboardAvoidingScreen>
  );
}

const TABLE_COLUMNS = ['Date', 'Due', 'Given', 'Medicine', 'Status', 'Qty', 'By', 'Notes'] as const;

const tableStyles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingBottom: 6,
    marginBottom: 4,
  },
  headerCell: {
    width: 96,
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingVertical: 6,
  },
  cell: {
    width: 96,
    color: colors.text,
    fontSize: 13,
  },
  wide: {
    width: 160,
  },
  muted: {
    color: colors.textMuted,
  },
});
