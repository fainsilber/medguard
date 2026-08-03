import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { getHouseholdSession } from '../api/session.js';
import { RepositoryProvider } from '../app/RepositoryContext.js';
import { HouseholdOnboarding } from '../features/household/HouseholdOnboarding.js';
import { buttonClass, inputClass } from '../ui/primitives.js';
import { getCaregiverName, setCaregiverName } from './caregiverName.js';

/**
 * The entry point of the app: nothing renders until we know who's using this device (safety
 * invariant 5 — every log records who; no anonymous entries), then wires that identity into the
 * database via RepositoryProvider.
 *
 * A device that has never been set up is offered a household first, since that is the normal path
 * now that a backend exists. Standing alone is still explicitly supported: the app is fully usable
 * offline on one device, and a caregiver with no signal must never be locked out of logging a dose
 * because a server cannot be reached.
 */
export function CaregiverGate({ children }: { children: ReactNode }) {
  const [name, setName] = useState<string | null>(() => getCaregiverName());
  const [standalone, setStandalone] = useState(() => getHouseholdSession() !== null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (name) {
    return <RepositoryProvider userId={name}>{children}</RepositoryProvider>;
  }

  if (!standalone) {
    return (
      <HouseholdOnboarding
        // The caregiver name is stored by the onboarding flow itself, so it is read back rather
        // than passed — one source of truth for who this device belongs to.
        onDone={() => {
          setName(getCaregiverName());
          setStandalone(true);
        }}
        onSkip={() => setStandalone(true)}
      />
    );
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    try {
      setCaregiverName(draft);
      setName(draft.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Please enter a name');
    }
  };

  return (
    <main className="mx-auto flex min-h-full max-w-sm flex-col justify-center gap-6 p-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">MedGuard</h1>
        <p className="mt-2 text-sm text-slate-400">
          Who&rsquo;s using this device? This name is attached to every dose you log, so the
          household always knows who gave what.
        </p>
      </div>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Your name
          <input
            className={inputClass}
            placeholder="e.g. Mom, Dad, Grandma"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            autoFocus
          />
        </label>
        {error && (
          <p className="text-locked text-sm" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className={buttonClass}>
          Continue
        </button>
      </form>
    </main>
  );
}
