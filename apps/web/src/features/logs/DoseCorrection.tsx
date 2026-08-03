import { useState } from 'react';
import type { FormEvent } from 'react';
import { formatLocalDate, formatLocalTime, fromIso, resolveLocal, toIso } from '@medguard/shared';
import type { IntakeLog, IntakeStatus } from '@medguard/shared';
import { useCurrentDeviceId, useCurrentUserId, useIdGenerator, useRepository } from '../../app/RepositoryContext.js';
import { buttonClass, inputClass, labelClass, primaryButtonClass } from '../../ui/primitives.js';

const CORRECTABLE_STATUSES: IntakeStatus[] = ['taken', 'skipped'];

/**
 * The full history of one occurrence, oldest first: the original log plus every correction that
 * superseded it. Corrections are never edits (safety invariant 1) — this is how that history
 * stays visible instead of vanishing behind the newest entry.
 */
function correctionChain(allLogs: readonly IntakeLog[], tipId: string): IntakeLog[] {
  const byId = new Map(allLogs.map((log) => [log.id, log]));
  const chain: IntakeLog[] = [];
  let current = byId.get(tipId);
  while (current) {
    chain.push(current);
    current = current.supersedesId !== undefined ? byId.get(current.supersedesId) : undefined;
  }
  return chain.reverse();
}

function CorrectionForm({
  original,
  timeZone,
  onDone,
  onCancel,
}: {
  original: IntakeLog;
  timeZone: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const repository = useRepository();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();

  const originalMs = fromIso(original.actualTime);
  const [status, setStatus] = useState<IntakeStatus>(original.status);
  const [quantity, setQuantity] = useState(String(original.quantityTaken));
  const [date, setDate] = useState(formatLocalDate(timeZone, originalMs));
  const [time, setTime] = useState(formatLocalTime(timeZone, originalMs));
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const quantityValue = status === 'skipped' ? 0 : Number(quantity);
    if (!(quantityValue >= 0)) {
      setError('Quantity must be zero or more.');
      return;
    }
    const trimmedNote = note.trim();
    if (!trimmedNote) {
      setError("Say what was wrong — it's recorded permanently alongside the correction.");
      return;
    }

    const resolved = resolveLocal(timeZone, date, time);

    setSaving(true);
    try {
      await repository.correctDose(original.id, {
        id: ids.next(),
        patientId: original.patientId,
        medicineId: original.medicineId,
        ...(original.scheduleId !== undefined ? { scheduleId: original.scheduleId } : {}),
        type: original.type,
        status,
        ...(original.scheduledTime !== undefined ? { scheduledTime: original.scheduledTime } : {}),
        actualTime: toIso(resolved.instantMs),
        quantityTaken: quantityValue,
        loggedByUserId: userId,
        loggedByDeviceId: deviceId,
        notes: trimmedNote,
        syncStatus: 'pending',
      });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(event) => void handleSubmit(event)}
      className="flex flex-col gap-2 rounded-md border border-slate-700 p-2 text-sm"
    >
      <div className="grid grid-cols-2 gap-2">
        <label className={labelClass}>
          Status
          <select
            className={inputClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as IntakeStatus)}
          >
            {CORRECTABLE_STATUSES.map((option) => (
              <option key={option} value={option}>
                {option === 'taken' ? 'Taken' : 'Skipped'}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Quantity
          <input
            className={inputClass}
            type="number"
            min="0"
            step="0.5"
            value={quantity}
            disabled={status === 'skipped'}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className={labelClass}>
          Date
          <input className={inputClass} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className={labelClass}>
          Time
          <input className={inputClass} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      <label className={labelClass}>
        What was wrong?
        <textarea className={inputClass} rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      </label>
      {error && (
        <p className="text-locked" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className={primaryButtonClass} disabled={saving}>
          {saving ? 'Saving…' : 'Save correction'}
        </button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Lets a caregiver correct a mistaken log entry (never edits it — appends a superseding one, PRD
 * safety invariant 1) and view the full history of what changed.
 */
export function DoseCorrection({
  allLogs,
  tipLog,
  timeZone,
}: {
  /** Every log for this medicine (or patient), so the full supersede chain can be found. */
  allLogs: readonly IntakeLog[];
  tipLog: IntakeLog;
  timeZone: string;
}) {
  const [correcting, setCorrecting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const chain = correctionChain(allLogs, tipLog.id);
  const hasHistory = chain.length > 1;

  if (correcting) {
    return (
      <CorrectionForm
        original={tipLog}
        timeZone={timeZone}
        onDone={() => setCorrecting(false)}
        onCancel={() => setCorrecting(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-3 text-xs">
        <button type="button" className="underline text-slate-400 hover:text-slate-200" onClick={() => setCorrecting(true)}>
          Correct
        </button>
        {hasHistory && (
          <button
            type="button"
            className="underline text-slate-400 hover:text-slate-200"
            onClick={() => setShowHistory((current) => !current)}
          >
            {showHistory ? 'Hide history' : `History (${chain.length})`}
          </button>
        )}
      </div>
      {showHistory && (
        <ul className="flex flex-col gap-1 rounded-md border border-slate-800 p-2 text-xs text-slate-400">
          {chain.map((log) => (
            <li key={log.id}>
              {formatLocalDate(timeZone, fromIso(log.actualTime))} {formatLocalTime(timeZone, fromIso(log.actualTime))} —{' '}
              {log.status === 'taken' ? `Taken (${log.quantityTaken})` : 'Skipped'} by {log.loggedByUserId}
              {log.notes ? ` — ${log.notes}` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
