import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  assessDose,
  blockReasonFor,
  formatCountdown,
  formatLocalDate,
  formatLocalTime,
  fromIso,
  isDosePermitted,
  lastAdministeredDose,
  resolveLocal,
  toIso,
} from '@medguard/shared';
import type { BlockReason, ClockTrust, DoseSafety, IntakeLog, IsoInstant, Medicine } from '@medguard/shared';
import {
  useClock,
  useCurrentDeviceId,
  useCurrentUserId,
  useIdGenerator,
  useRepository,
} from '../../app/RepositoryContext.js';
import { getLocalClockTrust } from '../../clock/localClockGuard.js';
import { DoseCorrection } from '../logs/DoseCorrection.js';
import { Card, buttonClass, dangerButtonClass, inputClass, primaryButtonClass } from '../../ui/primitives.js';

const STATE_BORDER_CLASS: Record<DoseSafety['state'], string> = {
  safe: 'border-safe',
  cooldown: 'border-locked',
  capped: 'border-capped',
  untrusted_clock: 'border-locked',
};

const STATE_LABEL: Record<DoseSafety['state'], string> = {
  safe: '🟢 Safe to take',
  cooldown: '🔴 Locked',
  capped: '⚫ Daily limit reached',
  untrusted_clock: '🔴 Clock unverified',
};

/**
 * Override needs two *deliberate, separate* confirmations before it writes anything — a reason
 * (required, becomes part of the permanent audit record) and then an explicit "yes, really" a
 * moment later. Neither step alone can trigger a dose: this exists so a caregiver can't mis-tap
 * their way past a cooldown at 3am.
 */
type OverridePhase = 'closed' | 'reason' | 'confirm';

export function PrnCard({
  medicine,
  logs,
  timeZone,
  clockTrust,
}: {
  medicine: Medicine;
  logs: readonly IntakeLog[];
  timeZone: string;
  /** Overrides the real local clock-trust check — exists for deterministic tests only. */
  clockTrust?: ClockTrust;
}) {
  const clock = useClock();
  const repository = useRepository();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();

  const [overridePhase, setOverridePhase] = useState<OverridePhase>('closed');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [customTime, setCustomTime] = useState('');

  const safety = assessDose({
    medicine,
    logs,
    clock,
    clockTrust: clockTrust ?? getLocalClockTrust(),
  });

  const resetOverride = () => {
    setOverridePhase('closed');
    setReason('');
  };

  const give = async (actualTimeIso: IsoInstant, override?: { reason: string; blockedBy: BlockReason }) => {
    setSaving(true);
    try {
      await repository.recordDose({
        id: ids.next(),
        patientId: medicine.patientId,
        medicineId: medicine.id,
        type: 'prn',
        status: 'taken',
        actualTime: actualTimeIso,
        quantityTaken: 1,
        loggedByUserId: userId,
        loggedByDeviceId: deviceId,
        syncStatus: 'pending',
        ...(override
          ? {
              override: {
                confirmedByUserId: userId,
                reason: override.reason,
                blockedBy: override.blockedBy,
              },
            }
          : {}),
      });
      resetOverride();
      setShowTimePicker(false);
    } finally {
      setSaving(false);
    }
  };

  const handleGive = () => void give(clock.nowIso());

  const openTimePicker = () => {
    setCustomTime(formatLocalTime(timeZone, clock.nowMs()));
    setShowTimePicker(true);
  };

  const handleCustomGive = (event: FormEvent) => {
    event.preventDefault();
    if (!customTime) return;
    const resolved = resolveLocal(timeZone, formatLocalDate(timeZone, clock.nowMs()), customTime);
    void give(toIso(resolved.instantMs));
  };

  const handleReasonSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) return;
    setOverridePhase('confirm');
  };

  const handleConfirmOverride = () => {
    const blockedBy = blockReasonFor(safety);
    if (!blockedBy) return; // unreachable: this button only renders when safety is blocked
    void give(clock.nowIso(), { reason: reason.trim(), blockedBy });
  };

  const permitted = isDosePermitted(safety);
  const lastLog = lastAdministeredDose(logs, medicine.id);

  return (
    <Card className={`border-l-4 ${STATE_BORDER_CLASS[safety.state]}`}>
      <div className="flex items-center justify-between">
        <h3 className="font-medium">
          {medicine.name} <span className="text-slate-400">{medicine.strength}</span>
        </h3>
        <span className="text-sm">{STATE_LABEL[safety.state]}</span>
      </div>

      {lastLog && (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-slate-400">
            Last given by {lastLog.loggedByUserId} at {formatLocalTime(timeZone, fromIso(lastLog.actualTime))} (
            {lastLog.quantityTaken})
          </p>
          <DoseCorrection allLogs={logs} tipLog={lastLog} timeZone={timeZone} />
        </div>
      )}

      {safety.state === 'cooldown' && (
        <p className="text-locked text-sm">Locked: {formatCountdown(safety.msRemaining)} remaining</p>
      )}
      {safety.state === 'capped' && (
        <p className="text-sm text-slate-300">
          Daily limit reached ({safety.dosesInWindow}/{safety.maxDailyDoses} doses in 24h). Resets in{' '}
          {formatCountdown(safety.msRemaining)}.
        </p>
      )}
      {safety.state === 'untrusted_clock' && (
        <p className="text-locked text-sm">
          This device&rsquo;s clock could not be verified, so the cooldown can&rsquo;t be confirmed
          safely. Try again in a moment.
        </p>
      )}

      {permitted && !showTimePicker && (
        <div className="flex gap-2">
          <button type="button" className={primaryButtonClass} disabled={saving} onClick={handleGive}>
            {saving ? 'Recording…' : 'Give dose'}
          </button>
          <button type="button" className={buttonClass} disabled={saving} onClick={openTimePicker}>
            Different time…
          </button>
        </div>
      )}

      {permitted && showTimePicker && (
        <form
          onSubmit={handleCustomGive}
          className="flex flex-wrap items-center gap-2 rounded-md border border-slate-700 p-2"
        >
          <label className="text-sm">
            When was it actually given?
            <input
              className={`${inputClass} w-auto`}
              type="time"
              value={customTime}
              aria-label="Time given"
              onChange={(event) => setCustomTime(event.target.value)}
            />
          </label>
          <button type="submit" className={primaryButtonClass} disabled={saving || !customTime}>
            {saving ? 'Recording…' : 'Save'}
          </button>
          <button type="button" className={buttonClass} disabled={saving} onClick={() => setShowTimePicker(false)}>
            Cancel
          </button>
        </form>
      )}

      {!permitted && overridePhase === 'closed' && (
        <button type="button" className={buttonClass} onClick={() => setOverridePhase('reason')}>
          Give anyway (override)
        </button>
      )}

      {!permitted && overridePhase === 'reason' && (
        <form onSubmit={handleReasonSubmit} className="flex flex-col gap-2 rounded-md border border-locked/40 p-2">
          <label className="text-sm">
            Why are you overriding this?
            <textarea
              className={inputClass}
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              autoFocus
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" className={dangerButtonClass} disabled={!reason.trim()}>
              Continue
            </button>
            <button type="button" className={buttonClass} onClick={resetOverride}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {!permitted && overridePhase === 'confirm' && (
        <div className="flex flex-col gap-2 rounded-md border border-locked p-2">
          <p className="text-locked text-sm font-medium" role="alert">
            Are you sure? This will be permanently recorded as an override.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={dangerButtonClass}
              disabled={saving}
              onClick={handleConfirmOverride}
            >
              {saving ? 'Recording…' : 'Yes, give the dose'}
            </button>
            <button type="button" className={buttonClass} onClick={resetOverride} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
