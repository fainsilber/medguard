import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import {
  buildIntakeLogCsv,
  effectiveLogs,
  formatLocalDate,
  formatLocalTime,
  fromIso,
} from '@medguard/shared';
import { useClock, useMedGuardDb } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { downloadTextFile } from '../../ui/download.js';
import { Card, buttonClass, primaryButtonClass } from '../../ui/primitives.js';
import { BackupRestoreCard } from './BackupRestoreCard.js';

/**
 * PRD Sprint 2 — "the app is a helper, not the only record". CSV for a spreadsheet, and a
 * printable summary for a hospital visit, in case the app is ever unavailable.
 */
export function ExportScreen() {
  const db = useMedGuardDb();
  const clock = useClock();
  const householdSettings = useHouseholdSettings();

  const medicines = useLiveQuery(() => db.medicines.toArray(), [db]);
  const logs = useLiveQuery(() => db.intakeLogs.toArray(), [db]);

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

  if (!medicines || !logs || !householdSettings || !rows) {
    return (
      <Card>
        <p className="text-sm text-slate-400">Loading…</p>
      </Card>
    );
  }

  const timeZone = householdSettings.timeZone;
  const generatedOn = formatLocalDate(timeZone, clock.nowMs());
  const isEmpty = rows.length === 0;

  const handleDownloadCsv = () => {
    downloadTextFile(
      buildIntakeLogCsv(logs, medicineNames, timeZone),
      `medguard-log-${generatedOn}.csv`,
      'text/csv;charset=utf-8',
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <Card className="print:hidden">
        <h2 className="text-lg font-semibold">Export</h2>
        <p className="text-sm text-slate-400">
          Keep a CSV or paper copy for hospital visits — this app is a helper, not the only record.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className={primaryButtonClass}
            disabled={isEmpty}
            onClick={handleDownloadCsv}
          >
            Download CSV
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={isEmpty}
            onClick={() => window.print()}
          >
            Print summary
          </button>
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Medication log</h2>
        <p className="text-xs text-slate-400">
          Generated {generatedOn} · {timeZone}
        </p>

        {isEmpty ? (
          <p className="text-sm text-slate-400">No doses logged yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-xs uppercase text-slate-400">
                <th className="py-1 pr-2">Date</th>
                <th className="py-1 pr-2">Due</th>
                <th className="py-1 pr-2">Given</th>
                <th className="py-1 pr-2">Medicine</th>
                <th className="py-1 pr-2">Status</th>
                <th className="py-1 pr-2">Qty</th>
                <th className="py-1 pr-2">By</th>
                <th className="py-1 pr-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((log) => (
                <tr key={log.id} className="border-b border-slate-800 align-top">
                  <td className="py-1 pr-2 whitespace-nowrap">
                    {formatLocalDate(timeZone, fromIso(log.actualTime))}
                  </td>
                  <td className="py-1 pr-2 whitespace-nowrap text-slate-400">
                    {log.scheduledTime === undefined
                      ? '—'
                      : formatLocalTime(timeZone, fromIso(log.scheduledTime))}
                  </td>
                  <td className="py-1 pr-2 whitespace-nowrap">
                    {formatLocalTime(timeZone, fromIso(log.actualTime))}
                  </td>
                  <td className="py-1 pr-2">
                    {medicineNames.get(log.medicineId) ?? 'Unknown medicine'}
                  </td>
                  <td className="py-1 pr-2">{log.status === 'taken' ? 'Taken' : 'Skipped'}</td>
                  <td className="py-1 pr-2">{log.quantityTaken}</td>
                  <td className="py-1 pr-2">{log.loggedByUserId}</td>
                  <td className="py-1 pr-2 text-slate-400">
                    {log.override
                      ? `Override (${log.override.blockedBy}): ${log.override.reason}`
                      : log.notes}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <BackupRestoreCard />
    </div>
  );
}
