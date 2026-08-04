import { useLiveQuery } from 'dexie-react-hooks';
import type { BlockReason } from '@medguard/shared';
import { useMedGuardDb } from '../app/RepositoryContext.js';
import { useSyncStatus } from './SyncProvider.js';

/**
 * Surfaces an incoming `safety.warning` broadcast to every caregiver in the household, not just
 * the one whose device attempted the dose — the whole point of delta D2's authoritative re-check
 * is that a race between two phones is visible to both, immediately.
 */

const REASON_LABEL: Record<BlockReason, string> = {
  cooldown: 'the minimum time between doses',
  daily_cap: "today's dose limit",
  untrusted_clock: 'an unverified clock',
};

export function SafetyWarningBanner() {
  const db = useMedGuardDb();
  const { lastSafetyWarning, dismissSafetyWarning } = useSyncStatus();

  const medicine = useLiveQuery(
    () => (lastSafetyWarning ? db.medicines.get(lastSafetyWarning.medicineId) : undefined),
    [db, lastSafetyWarning],
  );

  if (!lastSafetyWarning) {
    return null;
  }

  const medicineName = medicine?.name ?? 'A medicine';
  const reason = REASON_LABEL[lastSafetyWarning.blockedBy];

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-locked bg-locked/10 p-3 text-sm" role="alert">
      <p>
        {medicineName}:{' '}
        {lastSafetyWarning.outcome === 'blocked'
          ? `a dose was blocked by ${reason} — someone may have just tried to give it again too soon.`
          : `a dose was given despite ${reason}, recorded as an override.`}
      </p>
      <button type="button" className="shrink-0 text-slate-400 underline" onClick={dismissSafetyWarning}>
        Dismiss
      </button>
    </div>
  );
}
