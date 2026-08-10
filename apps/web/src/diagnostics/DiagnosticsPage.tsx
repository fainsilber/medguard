import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getApiBaseUrl, setApiBaseUrl } from '../api/config.js';
import { getHouseholdSession } from '../api/session.js';
import { APP_VERSION, BUILD_TIME } from '../version.js';
import { fetchVapidPublicKey, registerPushSubscription, unregisterPush } from '../push/pushApi.js';
import { subscribeToPush, unsubscribeFromPush } from '../push/pushClient.js';
import { AppLogSection } from './AppLogSection.js';
import { checkStoragePersistence, snapshotEnvironment } from './environment.js';
import type { EnvironmentSnapshot, StorageCheckResult } from './environment.js';

/**
 * What this device can actually do, and which build it is running.
 *
 * Sprint 0's capability probe lived here and answered its questions — a push does reach a locked
 * phone, on Android and on iOS once installed to the home screen; a browser never retains a
 * custom notification sound; a backgrounded timer drifts by tens of seconds
 * (`docs/platform-capabilities.md` has the measurements). Sprint A4 removed the probe's
 * unauthenticated relay route (delta AD8) and with it the burst controls and the delivery-receipt
 * table, which existed to answer questions that now have answers.
 *
 * What remains is the part a caregiver (or whoever is reading a bug report) still needs: which
 * build is running, whether push is actually registered, whether storage is safe from eviction,
 * and the app log.
 *
 * Deliberately exempt from the no-ambient-time lint rule, like the probe before it: this screen
 * exists to measure real platform behaviour, not to be a testable pure function.
 */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-slate-800 p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Badge({ ok, label }: { ok: boolean | null; label: string }) {
  const colour = ok === null ? 'text-slate-400' : ok ? 'text-safe' : 'text-locked';
  const mark = ok === null ? '?' : ok ? '✓' : '✗';
  return (
    <span className={colour}>
      {mark} {label}
    </span>
  );
}

const buttonClass =
  'rounded-md bg-slate-800 px-3 py-2 text-sm font-medium hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50';
const inputClass = 'rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm';

type PushState =
  | { kind: 'unknown' }
  | { kind: 'no_household' }
  | { kind: 'registered' }
  | { kind: 'not_registered' }
  | { kind: 'error'; message: string };

export function DiagnosticsPage() {
  // Shares its override with useClockTrust (the PRN screen's server-time check) rather than
  // keeping its own separate one: setting the API URL here used to have no effect on that check
  // at all, which made this field a confusing dead end when the two ever needed to agree.
  const [apiBaseUrl, setApiBaseUrlState] = useState(getApiBaseUrl);

  const [environment, setEnvironment] = useState<EnvironmentSnapshot | null>(null);
  const [storageResult, setStorageResult] = useState<StorageCheckResult | null>(null);
  const [storageChecking, setStorageChecking] = useState(false);
  const [pushState, setPushState] = useState<PushState>({ kind: 'unknown' });
  const [busy, setBusy] = useState(false);

  const refreshEnvironment = useCallback(() => {
    setEnvironment(snapshotEnvironment(window));
  }, []);

  useEffect(() => {
    refreshEnvironment();
    setPushState(getHouseholdSession() ? { kind: 'unknown' } : { kind: 'no_household' });
  }, [refreshEnvironment]);

  function persistApiBaseUrl(value: string): void {
    setApiBaseUrlState(value);
    setApiBaseUrl(value);
  }

  const handleCheckStorage = useCallback(async () => {
    setStorageChecking(true);
    try {
      setStorageResult(await checkStoragePersistence(navigator.storage));
    } finally {
      setStorageChecking(false);
    }
  }, []);

  const handleRequestPermission = useCallback(async () => {
    await Notification.requestPermission();
    refreshEnvironment();
  }, [refreshEnvironment]);

  /**
   * Subscribes and registers in one action.
   *
   * Deliberately one button rather than two: a browser subscription the server does not know
   * about is indistinguishable, from the caregiver's side, from no subscription at all — it just
   * silently never receives anything.
   */
  const handleRegister = useCallback(async () => {
    const session = getHouseholdSession();
    if (!session) {
      setPushState({ kind: 'no_household' });
      return;
    }

    setBusy(true);
    try {
      const key = await fetchVapidPublicKey(apiBaseUrl, session.deviceToken);
      if (!key.ok) {
        setPushState({ kind: 'error', message: key.error });
        return;
      }
      const subscription = await subscribeToPush(key.value.publicKey);
      const result = await registerPushSubscription(apiBaseUrl, session.deviceToken, subscription);
      setPushState(result.ok ? { kind: 'registered' } : { kind: 'error', message: result.error });
    } catch (error: unknown) {
      setPushState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Could not subscribe.',
      });
    } finally {
      setBusy(false);
      refreshEnvironment();
    }
  }, [apiBaseUrl, refreshEnvironment]);

  const handleUnregister = useCallback(async () => {
    const session = getHouseholdSession();
    setBusy(true);
    try {
      await unsubscribeFromPush();
      if (session) {
        await unregisterPush(apiBaseUrl, session.deviceToken);
      }
      setPushState({ kind: 'not_registered' });
    } finally {
      setBusy(false);
    }
  }, [apiBaseUrl]);

  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col gap-6 p-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">MedGuard</h1>
        <p className="text-sm text-slate-400">Diagnostics</p>
        {/* If this doesn't change after a merge to main, the deploy didn't actually happen —
            exactly the failure mode that motivated adding it (a silently disconnected
            Cloudflare Git integration). */}
        <p className="text-xs text-slate-500">
          v{APP_VERSION}
          {BUILD_TIME && ` · built ${new Date(BUILD_TIME).toLocaleString()}`}
        </p>
      </header>

      <Section title="1. Environment">
        {environment && (
          <div className="flex flex-col gap-1 text-sm">
            <div>Platform: {environment.platform}</div>
            <Badge ok={environment.serviceWorkerSupported} label="Service Worker supported" />
            <Badge ok={environment.pushManagerSupported} label="Push Manager supported" />
            <Badge ok={environment.notificationSupported} label="Notifications supported" />
            <div>Notification permission: {environment.notificationPermission}</div>
            <Badge ok={environment.installedStandalone} label="Installed to home screen / standalone" />
            {environment.needsHomeScreenInstall && (
              <p className="text-locked">
                iOS refuses Web Push until this is added to the home screen. Share → Add to Home
                Screen, then reopen from there before enabling alerts below.
              </p>
            )}
          </div>
        )}
        <button type="button" className={buttonClass} onClick={refreshEnvironment}>
          Refresh
        </button>
      </Section>

      <Section title="2. Dose alerts">
        <p className="text-sm text-slate-400">
          Alerts are sent by the server when a scheduled dose is due, and again to everyone in the
          household if nobody confirms it in time. This device has to be registered to receive
          them.
        </p>

        <label className="flex flex-col gap-1 text-sm">
          API base URL
          <input
            className={inputClass}
            value={apiBaseUrl}
            onChange={(event) => persistApiBaseUrl(event.target.value)}
            placeholder="https://medguard-api.<subdomain>.workers.dev"
          />
        </label>

        <button
          type="button"
          className={buttonClass}
          onClick={() => void handleRequestPermission()}
          disabled={
            !environment?.notificationSupported || environment.notificationPermission === 'granted'
          }
        >
          Enable notifications
        </button>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass}
            onClick={() => void handleRegister()}
            disabled={busy || environment?.notificationPermission !== 'granted'}
          >
            {busy ? 'Working…' : 'Register this device for alerts'}
          </button>
          <button
            type="button"
            className={buttonClass}
            onClick={() => void handleUnregister()}
            disabled={busy}
          >
            Stop alerts on this device
          </button>
        </div>

        {pushState.kind === 'registered' && (
          <p className="text-safe text-sm">Registered — this device will receive dose alerts.</p>
        )}
        {pushState.kind === 'not_registered' && (
          <p className="text-sm text-slate-400">
            Not registered. Local reminders still work while the app is open; alerts on a locked
            phone will not arrive.
          </p>
        )}
        {pushState.kind === 'no_household' && (
          <p className="text-sm text-slate-400">
            This device is not connected to a household yet — join one from the Household tab
            first.
          </p>
        )}
        {pushState.kind === 'error' && <p className="text-locked text-sm">{pushState.message}</p>}
      </Section>

      <Section title="3. Storage persistence">
        <p className="text-sm text-slate-400">
          Does the OS evict IndexedDB under storage pressure? Requests persistent storage and
          reports whether it was granted.
        </p>
        <button
          type="button"
          className={buttonClass}
          onClick={() => void handleCheckStorage()}
          disabled={storageChecking}
        >
          {storageChecking ? 'Checking…' : 'Check storage persistence'}
        </button>
        {storageResult && (
          <div className="text-sm">
            <Badge ok={storageResult.persistGranted} label="Persistent storage granted" />
            <div>
              Quota: {storageResult.quotaBytes ?? '—'} bytes, usage:{' '}
              {storageResult.usageBytes ?? '—'} bytes
            </div>
          </div>
        )}
      </Section>

      <Section title="4. App logs">
        <AppLogSection />
      </Section>
    </main>
  );
}
