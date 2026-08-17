import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { buildBackupBundle, parseBackupBundle, summarizeBackup } from '@medguard/shared';
import type {
  BackupBundle,
  BackupSummary,
  IntakeLog,
  InventoryAdjustment,
  InventoryItem,
  Medicine,
  MedicinePatient,
  Patient,
  Schedule,
} from '@medguard/shared';
import { useClock, useRepository, useStore } from '../../app/RepositoryContext.js';
import { Button, Card, colors, styles as sharedStyles } from '../../ui/primitives.js';
import { shareTextFile } from './shareTextFile.js';

/**
 * Full backup, restore, and wipe of the local medical data: medicines, schedules, the complete
 * intake history, and the inventory ledger. RN port of
 * `apps/web/src/features/export/BackupRestoreCard.tsx`.
 *
 * Distinct from the CSV in `ExportScreen`, which is a human-readable summary for a hospital
 * visit. This is a machine-readable, full-fidelity backup — what a caregiver would use to move
 * to a new device or recover after losing one, and includes everything the CSV leaves out
 * (superseded log entries, as-needed guard configuration, the raw inventory ledger).
 *
 * I/O is the one place this genuinely differs from web: there's no `<input type=file>` or
 * `FileReader` on this platform, so exporting goes through `shareTextFile` (write to cache, hand
 * to the OS share sheet) and importing goes through `expo-document-picker` +
 * `expo-file-system`'s `readAsStringAsync`. The state machine — idle / previewing / error, with
 * an explicit confirm step before `restoreBackup` ever runs — is unchanged.
 */

type ImportPhase =
  | { step: 'idle' }
  | { step: 'previewing'; bundle: BackupBundle; summary: BackupSummary }
  | { step: 'error'; message: string };

const CLEAR_CONFIRMATION_PHRASE = 'DELETE';

const INVALID_BACKUP_MESSAGE =
  'That file could not be read as a MedGuard backup — it may not be valid JSON.';

export function BackupRestoreCard(): React.JSX.Element {
  const store = useStore();
  const repository = useRepository();
  const clock = useClock();

  const [importPhase, setImportPhase] = useState<ImportPhase>({ step: 'idle' });
  const [importing, setImporting] = useState(false);
  const [pickingFile, setPickingFile] = useState(false);
  const [importedAt, setImportedAt] = useState<number | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [clearing, setClearing] = useState(false);
  const [clearText, setClearText] = useState('');
  const [clearBusy, setClearBusy] = useState(false);
  const [clearedAt, setClearedAt] = useState<number | null>(null);

  const handleExport = async () => {
    setExportError(null);
    setExporting(true);
    try {
      const [
        patients,
        medicinePatients,
        medicines,
        schedules,
        intakeLogs,
        inventoryItems,
        inventoryAdjustments,
      ] = await Promise.all([
        store.transaction(['patients'], (tx) => tx.getAll<Patient>('patients')),
        store.transaction(['medicinePatients'], (tx) =>
          tx.getAll<MedicinePatient>('medicinePatients'),
        ),
        store.transaction(['medicines'], (tx) => tx.getAll<Medicine>('medicines')),
        store.transaction(['schedules'], (tx) => tx.getAll<Schedule>('schedules')),
        store.transaction(['intakeLogs'], (tx) => tx.getAll<IntakeLog>('intakeLogs')),
        store.transaction(['inventoryItems'], (tx) => tx.getAll<InventoryItem>('inventoryItems')),
        store.transaction(['inventoryAdjustments'], (tx) =>
          tx.getAll<InventoryAdjustment>('inventoryAdjustments'),
        ),
      ]);

      const bundle = buildBackupBundle(
        {
          patients,
          medicinePatients,
          medicines,
          schedules,
          intakeLogs,
          inventoryItems,
          inventoryAdjustments,
        },
        clock,
      );

      await shareTextFile(
        JSON.stringify(bundle, null, 2),
        `medguard-backup-${bundle.exportedAt.slice(0, 10)}.json`,
        'application/json',
      );
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Could not share the backup file.');
    } finally {
      setExporting(false);
    }
  };

  const handlePickFile = async () => {
    setImportedAt(null);
    setPickingFile(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: 'application/json' });
      if (picked.canceled) {
        return;
      }
      const asset = picked.assets[0];
      if (!asset) {
        return;
      }

      let raw: string;
      let parsedJson: unknown;
      try {
        raw = await FileSystem.readAsStringAsync(asset.uri);
        parsedJson = JSON.parse(raw);
      } catch {
        setImportPhase({ step: 'error', message: INVALID_BACKUP_MESSAGE });
        return;
      }

      const result = parseBackupBundle(parsedJson);
      if (!result.ok) {
        setImportPhase({ step: 'error', message: result.error });
        return;
      }
      setImportPhase({
        step: 'previewing',
        bundle: result.bundle,
        summary: summarizeBackup(result.bundle),
      });
    } finally {
      setPickingFile(false);
    }
  };

  const handleConfirmImport = async () => {
    if (importPhase.step !== 'previewing') {
      return;
    }
    setImporting(true);
    try {
      await repository.restoreBackup(importPhase.bundle);
      setImportPhase({ step: 'idle' });
      setImportedAt(clock.nowMs());
    } finally {
      setImporting(false);
    }
  };

  const handleConfirmClear = async () => {
    setClearBusy(true);
    try {
      await repository.clearAllData();
      setClearing(false);
      setClearText('');
      setClearedAt(clock.nowMs());
    } finally {
      setClearBusy(false);
    }
  };

  return (
    <Card>
      <Text style={sharedStyles.title}>Backup &amp; restore</Text>
      <Text style={sharedStyles.subtitle}>
        A complete copy of every medicine, schedule, dose logged, and stock change on this device —
        what you would use to move to a new device or recover after losing one.
      </Text>

      <View style={sharedStyles.row}>
        <Button
          label={exporting ? 'Sharing…' : 'Share full backup'}
          onPress={() => void handleExport()}
          disabled={exporting}
        />
        <Button
          label={pickingFile ? 'Opening…' : 'Import backup…'}
          onPress={() => void handlePickFile()}
          disabled={pickingFile}
        />
      </View>

      {exportError && (
        <Text style={sharedStyles.errorText} accessibilityRole="alert">
          {exportError}
        </Text>
      )}

      {importedAt !== null && (
        <Text style={{ color: colors.safe, fontSize: 13 }}>Backup imported.</Text>
      )}

      {importPhase.step === 'error' && (
        <Text style={sharedStyles.errorText} accessibilityRole="alert">
          {importPhase.message}
        </Text>
      )}

      {importPhase.step === 'previewing' && (
        <View style={previewStyles.box}>
          <Text style={{ color: colors.text, fontSize: 13 }}>This file contains:</Text>
          <View style={{ gap: 2 }}>
            <Text style={sharedStyles.subtitle}>{importPhase.summary.patients} patient(s)</Text>
            <Text style={sharedStyles.subtitle}>{importPhase.summary.medicines} medicine(s)</Text>
            <Text style={sharedStyles.subtitle}>{importPhase.summary.schedules} schedule(s)</Text>
            <Text style={sharedStyles.subtitle}>{importPhase.summary.intakeLogs} log entries</Text>
            <Text style={sharedStyles.subtitle}>
              {importPhase.summary.inventoryItems} inventory setting(s)
            </Text>
            <Text style={sharedStyles.subtitle}>
              {importPhase.summary.inventoryAdjustments} stock change(s)
            </Text>
          </View>
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>
            Importing adds this to what is already on this device — existing data is not removed.
          </Text>
          <View style={sharedStyles.row}>
            <Button
              label={importing ? 'Importing…' : 'Import'}
              onPress={() => void handleConfirmImport()}
              disabled={importing}
              variant="primary"
            />
            <Button
              label="Cancel"
              onPress={() => setImportPhase({ step: 'idle' })}
              disabled={importing}
            />
          </View>
        </View>
      )}

      <View style={previewStyles.section}>
        {!clearing ? (
          <Button
            label="Clear all data on this device"
            onPress={() => setClearing(true)}
            variant="danger"
          />
        ) : (
          <View style={previewStyles.dangerBox}>
            <Text style={previewStyles.dangerText} accessibilityRole="alert">
              This permanently deletes every medicine, schedule, dose logged, and stock record on
              this device. Consider sharing a backup first.
            </Text>
            <View>
              <Text style={sharedStyles.label}>Type {CLEAR_CONFIRMATION_PHRASE} to confirm</Text>
              <TextInput
                style={sharedStyles.input}
                value={clearText}
                onChangeText={setClearText}
                autoFocus
                accessibilityLabel={`Type ${CLEAR_CONFIRMATION_PHRASE} to confirm`}
              />
            </View>
            <View style={sharedStyles.row}>
              <Button
                label={clearBusy ? 'Clearing…' : 'Clear everything'}
                onPress={() => void handleConfirmClear()}
                disabled={clearBusy || clearText !== CLEAR_CONFIRMATION_PHRASE}
                variant="danger"
              />
              <Button
                label="Cancel"
                onPress={() => {
                  setClearing(false);
                  setClearText('');
                }}
                disabled={clearBusy}
              />
            </View>
          </View>
        )}

        {clearedAt !== null && (
          <Text style={{ color: colors.textMuted, fontSize: 12 }}>All local data cleared.</Text>
        )}
      </View>
    </Card>
  );
}

const previewStyles = StyleSheet.create({
  box: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: 12,
    gap: 8,
  },
  dangerBox: {
    borderWidth: 1,
    borderColor: colors.locked,
    borderRadius: 8,
    padding: 12,
    gap: 8,
  },
  dangerText: {
    color: colors.locked,
    fontWeight: '600',
    fontSize: 13,
  },
});
