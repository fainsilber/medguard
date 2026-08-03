import { useState } from 'react';
import { getApiBaseUrl } from '../../api/config.js';
import { issueJoinCode } from '../../api/householdApi.js';
import { getHouseholdSession } from '../../api/session.js';
import { Card, buttonClass, primaryButtonClass } from '../../ui/primitives.js';

/**
 * The household screen: who this device syncs with, and how to invite another caregiver.
 *
 * The code is shown large and spaced because it gets read aloud across a room, and it carries its
 * own expiry so nobody writes one on a whiteboard and expects it to work tomorrow.
 */
export function HouseholdScreen() {
  const session = getHouseholdSession();
  const [code, setCode] = useState<string | null>(null);
  const [expiresInSeconds, setExpiresInSeconds] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!session) {
    return (
      <Card>
        <h2 className="text-lg font-semibold">Household</h2>
        <p className="text-sm text-slate-400">
          This device isn&rsquo;t connected to a household. It still works on its own — everything
          is stored locally — but doses won&rsquo;t be shared with another caregiver&rsquo;s phone.
        </p>
      </Card>
    );
  }

  const handleInvite = async () => {
    setError(null);
    setBusy(true);
    const result = await issueJoinCode(getApiBaseUrl(), session.deviceToken);
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCode(result.value.code);
    setExpiresInSeconds(result.value.expiresInSeconds);
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold">Household</h2>
      <p className="text-sm text-slate-400">
        {session.householdName ? `Connected to ${session.householdName}.` : 'Connected.'} Doses
        logged here are shared with every caregiver in this household.
      </p>

      <div className="flex flex-col gap-2">
        <button type="button" className={primaryButtonClass} disabled={busy} onClick={() => void handleInvite()}>
          {busy ? 'Creating code…' : 'Invite another caregiver'}
        </button>

        {code && (
          <div className="flex flex-col gap-1 rounded-md border border-slate-700 p-3 text-center">
            <p className="text-3xl font-semibold tracking-[0.3em]">{code}</p>
            <p className="text-xs text-slate-400">
              Enter this on the other phone
              {expiresInSeconds !== null && ` within ${Math.round(expiresInSeconds / 60)} minutes`}. It
              works once.
            </p>
            <button type="button" className={`${buttonClass} mt-1`} onClick={() => setCode(null)}>
              Done
            </button>
          </div>
        )}

        {error && (
          <p className="text-locked text-sm" role="alert">
            {error}
          </p>
        )}
      </div>
    </Card>
  );
}
