import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { buildBackupBundle, parseBackupBundle, summarizeBackup } from '@medguard/shared';
import type { BackupBundle, BackupSummary } from '@medguard/shared';
import { useClock, useMedGuardDb, useRepository } from '../../app/RepositoryContext.js';
import { downloadTextFile } from '../../ui/download.js';
import {
  Card,
  buttonClass,
  dangerButtonClass,
  inputClass,
  labelClass,
  primaryButtonClass,
} from '../../ui/primitives.js';

/**
 * Full backup, restore, and wipe of the local medical data: medicines, schedules, the complete
 * intake history, and the inventory ledger.
 *
 * Distinct from the CSV above it, which is a human-readable summary for a hospital visit. This is
 * a machine-readable, full-fidelity backup — what a caregiver would use to move to a new device or
 * recover after losing one, and includes everything the CSV leaves out (superseded log entries,
 * as-needed guard configuration, the raw inventory ledger).
 */

type ImportPhase =
  | { step: 'idle' }
  | { step: 'previewing'; bundle: BackupBundle; summary: BackupSummary }
  | { step: 'error'; message: string };

const CLEAR_CONFIRMATION_PHRASE = 'DELETE';

/**
 * `File.prototype.text()` doesn't exist in every environment this runs under (notably jsdom, so
 * the test suite needs this too) — `FileReader` is the one file-reading API with genuinely
 * universal support.
 */
function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsText(file);
  });
}

export function BackupRestoreCard() {
  const db = useMedGuardDb();
  const repository = useRepository();
  const clock = useClock();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [importPhase, setImportPhase] = useState<ImportPhase>({ step: 'idle' });
  const [importing, setImporting] = useState(false);
  const [importedAt, setImportedAt] = useState<number | null>(null);

  const [clearing, setClearing] = useState(false);
  const [clearText, setClearText] = useState('');
  const [clearBusy, setClearBusy] = useState(false);
  const [clearedAt, setClearedAt] = useState<number | null>(null);

  const handleExport = async () => {
    const [
      patients,
      medicinePatients,
      medicines,
      schedules,
      intakeLogs,
      inventoryItems,
      inventoryAdjustments,
    ] = await Promise.all([
      db.patients.toArray(),
      db.medicinePatients.toArray(),
      db.medicines.toArray(),
      db.schedules.toArray(),
      db.intakeLogs.toArray(),
      db.inventoryItems.toArray(),
      db.inventoryAdjustments.toArray(),
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

    downloadTextFile(
      JSON.stringify(bundle, null, 2),
      `medguard-backup-${bundle.exportedAt.slice(0, 10)}.json`,
      'application/json',
    );
  };

  const handleFileSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared immediately so picking the same file again (after fixing it, say) still fires onChange.
    event.target.value = '';
    if (!file) {
      return;
    }

    setImportedAt(null);
    try {
      const parsed: unknown = JSON.parse(await readFileAsText(file));
      const result = parseBackupBundle(parsed);
      if (!result.ok) {
        setImportPhase({ step: 'error', message: result.error });
        return;
      }
      setImportPhase({
        step: 'previewing',
        bundle: result.bundle,
        summary: summarizeBackup(result.bundle),
      });
    } catch {
      setImportPhase({
        step: 'error',
        message: 'That file could not be read as a MedGuard backup — it may not be valid JSON.',
      });
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
    <Card className="print:hidden">
      <h2 className="text-lg font-semibold">Backup &amp; restore</h2>
      <p className="text-sm text-slate-400">
        A complete copy of every medicine, schedule, dose logged, and stock change on this device —
        what you&rsquo;d use to move to a new device or recover after losing one.
      </p>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} onClick={() => void handleExport()}>
          Download full backup
        </button>
        <button type="button" className={buttonClass} onClick={() => fileInputRef.current?.click()}>
          Import backup…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          aria-label="Import backup file"
          className="hidden"
          onChange={(event) => void handleFileSelected(event)}
        />
      </div>

      {importedAt !== null && <p className="text-safe text-sm">Backup imported.</p>}

      {importPhase.step === 'error' && (
        <p className="text-locked text-sm" role="alert">
          {importPhase.message}
        </p>
      )}

      {importPhase.step === 'previewing' && (
        <div className="flex flex-col gap-2 rounded-md border border-slate-700 p-3 text-sm">
          <p>This file contains:</p>
          <ul className="list-disc pl-5 text-slate-300">
            <li>{importPhase.summary.patients} patient(s)</li>
            <li>{importPhase.summary.medicines} medicine(s)</li>
            <li>{importPhase.summary.schedules} schedule(s)</li>
            <li>{importPhase.summary.intakeLogs} log entries</li>
            <li>{importPhase.summary.inventoryItems} inventory setting(s)</li>
            <li>{importPhase.summary.inventoryAdjustments} stock change(s)</li>
          </ul>
          <p className="text-xs text-slate-400">
            Importing adds this to what&rsquo;s already on this device — existing data is not
            removed.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={primaryButtonClass}
              disabled={importing}
              onClick={() => void handleConfirmImport()}
            >
              {importing ? 'Importing…' : 'Import'}
            </button>
            <button
              type="button"
              className={buttonClass}
              disabled={importing}
              onClick={() => setImportPhase({ step: 'idle' })}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-slate-800 pt-3">
        {!clearing ? (
          <button type="button" className={dangerButtonClass} onClick={() => setClearing(true)}>
            Clear all data on this device
          </button>
        ) : (
          <div className="flex flex-col gap-2 rounded-md border border-locked p-3 text-sm">
            <p className="font-medium text-locked" role="alert">
              This permanently deletes every medicine, schedule, dose logged, and stock record on
              this device. Consider downloading a backup first.
            </p>
            <label className={labelClass}>
              Type {CLEAR_CONFIRMATION_PHRASE} to confirm
              <input
                className={inputClass}
                value={clearText}
                onChange={(event) => setClearText(event.target.value)}
                autoFocus
              />
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                className={dangerButtonClass}
                disabled={clearBusy || clearText !== CLEAR_CONFIRMATION_PHRASE}
                onClick={() => void handleConfirmClear()}
              >
                {clearBusy ? 'Clearing…' : 'Clear everything'}
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={clearBusy}
                onClick={() => {
                  setClearing(false);
                  setClearText('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {clearedAt !== null && <p className="text-xs text-slate-400">All local data cleared.</p>}
      </div>
    </Card>
  );
}
