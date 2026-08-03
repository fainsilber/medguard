import { fromIso } from './clock.js';
import { effectiveLogs } from './logs.js';
import { formatLocalDate, formatLocalTime } from './timezone.js';
import type { IntakeLog, Uuid } from './types.js';

/**
 * CSV export of the medication log (PRD Sprint 2 — "the app is a helper, not the only record").
 *
 * Only effective logs are exported: a superseded entry was a mistake, and printing it alongside
 * its correction would tell a clinician a dose happened twice.
 *
 * Pure and total: no clock reads, no I/O, so the exact output is directly testable.
 */

const CSV_HEADER = [
  'Date',
  'Time',
  'Medicine',
  'Type',
  'Status',
  'Quantity',
  'Given by',
  'Override reason',
  'Notes',
];

/** Quotes a field only when it needs it, per RFC 4180. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function statusLabel(status: IntakeLog['status']): string {
  switch (status) {
    case 'taken':
      return 'Taken';
    case 'skipped':
      return 'Skipped';
    case 'missed':
      return 'Missed';
    case 'pending_shabbat':
      return 'Pending (Shabbat)';
  }
}

/**
 * Builds the CSV text for a household's medication log, oldest entry first — the order a
 * caregiver would read a paper chart in.
 */
export function buildIntakeLogCsv(
  logs: readonly IntakeLog[],
  medicineNames: ReadonlyMap<Uuid, string>,
  timeZone: string,
): string {
  const rows = [...effectiveLogs(logs)].sort((a, b) => fromIso(a.actualTime) - fromIso(b.actualTime));

  const lines = [CSV_HEADER.map(csvField).join(',')];
  for (const log of rows) {
    const instantMs = fromIso(log.actualTime);
    lines.push(
      [
        formatLocalDate(timeZone, instantMs),
        formatLocalTime(timeZone, instantMs),
        medicineNames.get(log.medicineId) ?? 'Unknown medicine',
        log.type === 'prn' ? 'As needed' : 'Scheduled',
        statusLabel(log.status),
        String(log.quantityTaken),
        log.loggedByUserId,
        log.override?.reason ?? '',
        log.notes ?? '',
      ]
        .map(csvField)
        .join(','),
    );
  }

  // CRLF per RFC 4180, so the file opens cleanly in spreadsheet tools that expect it.
  return lines.map((line) => line + '\r\n').join('');
}
