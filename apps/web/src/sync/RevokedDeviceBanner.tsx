import { useState } from 'react';
import { buttonClass, dangerButtonClass } from '../ui/primitives.js';
import { useSyncStatus } from './SyncProvider.js';

/**
 * Shown when this device's own token has been revoked — someone (possibly on another device)
 * removed it from the household via `HouseholdScreen`'s device list. Sync has already stopped
 * (`SyncStatusBadge` shows "Removed"); this banner is what tells the caregiver on this browser
 * *why*, and gives them a deliberate, two-step way to clear the medical data still sitting on it
 * — never automatic, since a caregiver's dosing history disappearing without a confirmed action
 * is its own kind of harm.
 *
 * Without this, a revoked web session has no way out: every `HouseholdScreen` action (leave,
 * delete, list devices) round-trips through the now-invalid token and just fails, leaving the
 * caregiver stuck looking at stale local data that will never sync again.
 */
export function RevokedDeviceBanner() {
  const { status, clearRevokedDevice } = useSyncStatus();
  const [confirming, setConfirming] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [clearing, setClearing] = useState(false);

  if (status.kind !== 'revoked' || dismissed) {
    return null;
  }

  const handleConfirmClear = async () => {
    setClearing(true);
    await clearRevokedDevice();
    // No further state update needed on success: clearing the session flips `status` back to
    // `'disconnected'` via `SyncProvider`'s own session-change effect, which unmounts this banner.
  };

  return (
    <div
      className="flex flex-col gap-3 rounded-md border border-locked bg-locked/10 p-3 text-sm"
      role="alert"
    >
      <p>
        This device was removed from the household and will no longer sync. Any medicines, doses
        or logs already on this device are still here until you clear them.
      </p>

      {!confirming ? (
        <div className="flex gap-2">
          <button type="button" className={dangerButtonClass} onClick={() => setConfirming(true)}>
            Clear local data
          </button>
          <button type="button" className={buttonClass} onClick={() => setDismissed(true)}>
            Not now
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            className={dangerButtonClass}
            disabled={clearing}
            onClick={() => void handleConfirmClear()}
          >
            {clearing ? 'Clearing…' : 'Yes, clear it'}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={clearing}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
