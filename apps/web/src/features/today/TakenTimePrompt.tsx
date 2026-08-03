import { useState } from 'react';
import { formatLocalDate, formatLocalTime, fromIso, resolveLocal, toIso } from '@medguard/shared';
import type { EpochMs, IsoInstant } from '@medguard/shared';
import { buttonClass, inputClass, primaryButtonClass } from '../../ui/primitives.js';

/**
 * Asks when an overdue dose was *actually* given, rather than assuming it was given the moment
 * someone got round to tapping the button.
 *
 * A caregiver who gave the 08:00 dose on time but only acknowledged the notification at 09:15
 * would otherwise have 09:15 recorded — which is wrong twice over: the history misrepresents when
 * the child was actually medicated, and the rolling-24h cap arithmetic then starts its window
 * from the wrong instant.
 *
 * Only shown for overdue doses. When a dose is logged at roughly the time it was due there is no
 * ambiguity to resolve, and at 3am an extra confirmation step is a cost with no benefit.
 */
export function TakenTimePrompt({
  dueAtIso,
  nowMs,
  timeZone,
  saving,
  onConfirm,
  onCancel,
}: {
  dueAtIso: IsoInstant;
  nowMs: EpochMs;
  timeZone: string;
  saving: boolean;
  onConfirm: (actualTimeIso: IsoInstant) => void;
  onCancel: () => void;
}) {
  const dueMs = fromIso(dueAtIso);
  const dueLabel = formatLocalTime(timeZone, dueMs);
  const nowLabel = formatLocalTime(timeZone, nowMs);

  const [customTime, setCustomTime] = useState(nowLabel);
  const [showCustom, setShowCustom] = useState(false);

  const handleCustomConfirm = () => {
    // Resolved against the day the dose was *due*, not today: a 23:00 dose acknowledged after
    // midnight still belongs to the day it was scheduled for.
    const resolved = resolveLocal(timeZone, formatLocalDate(timeZone, dueMs), customTime);
    onConfirm(toIso(resolved.instantMs));
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-700 bg-slate-900/50 p-3 text-sm">
      <p className="font-medium">When was it actually taken?</p>

      {!showCustom ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={primaryButtonClass}
            disabled={saving}
            onClick={() => onConfirm(dueAtIso)}
          >
            On time — {dueLabel}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={saving}
            onClick={() => onConfirm(toIso(nowMs))}
          >
            Just now — {nowLabel}
          </button>
          <button type="button" className={buttonClass} disabled={saving} onClick={() => setShowCustom(true)}>
            Another time
          </button>
          <button type="button" className={buttonClass} disabled={saving} onClick={onCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${inputClass} w-auto`}
            type="time"
            value={customTime}
            aria-label="Time taken"
            onChange={(event) => setCustomTime(event.target.value)}
          />
          <button
            type="button"
            className={primaryButtonClass}
            disabled={saving || !customTime}
            onClick={handleCustomConfirm}
          >
            {saving ? 'Recording…' : 'Save'}
          </button>
          <button type="button" className={buttonClass} disabled={saving} onClick={onCancel}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
