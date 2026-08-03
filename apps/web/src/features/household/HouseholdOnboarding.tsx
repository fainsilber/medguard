import { useState } from 'react';
import type { FormEvent } from 'react';
import { getApiBaseUrl } from '../../api/config.js';
import { createHousehold, redeemJoinCode } from '../../api/householdApi.js';
import { setHouseholdSession } from '../../api/session.js';
import type { HouseholdSession } from '../../api/session.js';
import { setCaregiverName } from '../../identity/caregiverName.js';
import { buttonClass, inputClass, labelClass, primaryButtonClass } from '../../ui/primitives.js';

/**
 * First run: start a household, or join one someone else already started.
 *
 * Deliberately skippable. The app works entirely offline on one device — that was the whole point
 * of Sprint 2 — and a caregiver standing in a hospital with no signal must not be blocked from
 * logging a dose because a server is unreachable. Connecting can happen later.
 */
type Mode = 'choose' | 'create' | 'join';

export function HouseholdOnboarding({
  onDone,
  onSkip,
}: {
  onDone: () => void;
  onSkip: () => void;
}) {
  const [mode, setMode] = useState<Mode>('choose');
  const [householdName, setHouseholdName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = (session: HouseholdSession, name: string) => {
    setHouseholdSession(session);
    // The caregiver name is what every dose log is attributed to (safety invariant 5), so it is
    // stored locally too rather than re-fetched.
    setCaregiverName(name);
    onDone();
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const trimmedHousehold = householdName.trim();
    const trimmedName = displayName.trim();
    if (!trimmedHousehold || !trimmedName) {
      setError('Please fill in both fields.');
      return;
    }

    setBusy(true);
    const result = await createHousehold(getApiBaseUrl(), {
      householdName: trimmedHousehold,
      displayName: trimmedName,
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    finish({ ...result.value, householdName: trimmedHousehold }, trimmedName);
  };

  const handleJoin = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const trimmedName = displayName.trim();
    const trimmedCode = code.trim();
    if (!/^\d{6}$/.test(trimmedCode)) {
      setError('A join code is six digits.');
      return;
    }
    if (!trimmedName) {
      setError('Please enter your name.');
      return;
    }

    setBusy(true);
    const result = await redeemJoinCode(getApiBaseUrl(), {
      code: trimmedCode,
      displayName: trimmedName,
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    finish(result.value, trimmedName);
  };

  return (
    <main className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-6 p-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">MedGuard</h1>
        <p className="mt-2 text-sm text-slate-400">
          {mode === 'choose'
            ? 'Set up a household so every caregiver sees the same doses, or carry on alone on this device.'
            : mode === 'create'
              ? 'You can invite the other caregivers once this is set up.'
              : 'Ask the caregiver who set up the household for a 6-digit code.'}
        </p>
      </div>

      {mode === 'choose' && (
        <div className="flex flex-col gap-3">
          <button type="button" className={primaryButtonClass} onClick={() => setMode('create')}>
            Start a new household
          </button>
          <button type="button" className={buttonClass} onClick={() => setMode('join')}>
            Join with a code
          </button>
          <button type="button" className="text-sm text-slate-400 underline" onClick={onSkip}>
            Use this device on its own for now
          </button>
        </div>
      )}

      {mode === 'create' && (
        <form onSubmit={(event) => void handleCreate(event)} className="flex flex-col gap-3">
          <label className={labelClass}>
            Household name
            <input
              className={inputClass}
              placeholder="e.g. The Cohens"
              value={householdName}
              onChange={(event) => setHouseholdName(event.target.value)}
              autoFocus
            />
          </label>
          <label className={labelClass}>
            Your name
            <input
              className={inputClass}
              placeholder="e.g. Mom"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          {error && (
            <p className="text-locked text-sm" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={busy}>
              {busy ? 'Creating…' : 'Create household'}
            </button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => setMode('choose')}>
              Back
            </button>
          </div>
        </form>
      )}

      {mode === 'join' && (
        <form onSubmit={(event) => void handleJoin(event)} className="flex flex-col gap-3">
          <label className={labelClass}>
            Join code
            <input
              className={`${inputClass} text-center text-2xl tracking-[0.4em]`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </label>
          <label className={labelClass}>
            Your name
            <input
              className={inputClass}
              placeholder="e.g. Dad"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          {error && (
            <p className="text-locked text-sm" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={busy}>
              {busy ? 'Joining…' : 'Join household'}
            </button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => setMode('choose')}>
              Back
            </button>
          </div>
        </form>
      )}
    </main>
  );
}
