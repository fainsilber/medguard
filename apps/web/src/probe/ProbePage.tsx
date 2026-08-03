import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { SHABBAT_BURST_COUNT, SHABBAT_BURST_SPACING_MS } from '@medguard/shared';
import type { ProbeNotificationOptions, ProbePushLog, ProbePushReceipt } from '@medguard/shared';
import { getApiBaseUrl, setApiBaseUrl } from '../api/config.js';
import {
  checkStoragePersistence,
  snapshotEnvironment,
} from './environment.js';
import type { EnvironmentSnapshot, StorageCheckResult } from './environment.js';
import { clearReceipts, getReceipts } from './receiptStore.js';
import { subscribeToPush } from './pushClient.js';
import { fetchServerLog, fetchVapidPublicKey, scheduleBurst } from './probeApi.js';
import type { ScheduleBurstResult } from './probeApi.js';
import { createTimerSurvivalProbe } from './timerSurvival.js';
import type { TimerSurvivalResult } from './timerSurvival.js';
import { APP_VERSION, BUILD_TIME } from '../version.js';

/**
 * Sprint 0 capability probe: answers "does the platform actually do this" with evidence from
 * the device it's running on, rather than from the spec. See sprint plan § Sprint 0.
 *
 * Deliberately self-contained under src/probe/ rather than src/features/ — this is throwaway
 * diagnostic tooling, not domain logic, and is deleted or folded into the real push flow once
 * Sprint 5 lands. That's also why it's exempt from the no-ambient-time lint rule: it exists to
 * measure real wall-clock and platform behavior, not to be a testable pure function.
 */

const PROBE_ID_STORAGE_KEY = 'medguard-probe-id';

function loadOrCreateProbeId(): string {
  const existing = localStorage.getItem(PROBE_ID_STORAGE_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  localStorage.setItem(PROBE_ID_STORAGE_KEY, created);
  return created;
}

interface MergedResult {
  burstIndex: number;
  burstTotal: number;
  dueAtIso: string;
  serverSentAtIso: string;
  serverOk: boolean;
  serverStatus: number;
  serverError: string | undefined;
  latenessMs: number;
  receivedAtIso: string | null;
  deliveryLatencyMs: number | null;
  retainedOptions: string[] | null;
}

function mergeResults(serverLog: ProbePushLog | null, receipts: ProbePushReceipt[]): MergedResult[] {
  if (!serverLog) return [];

  const receiptBySentAt = new Map(receipts.map((receipt) => [receipt.sentAtIso, receipt]));

  return serverLog.sent.map((record) => {
    const receipt = receiptBySentAt.get(record.sentAtIso);
    return {
      burstIndex: record.burstIndex,
      burstTotal: record.burstTotal,
      dueAtIso: record.dueAtIso,
      serverSentAtIso: record.sentAtIso,
      serverOk: record.ok,
      serverStatus: record.status,
      serverError: record.error,
      latenessMs: record.latenessMs,
      receivedAtIso: receipt?.receivedAtIso ?? null,
      deliveryLatencyMs: receipt
        ? Date.parse(receipt.receivedAtIso) - Date.parse(record.sentAtIso)
        : null,
      retainedOptions: receipt?.retainedOptions ?? null,
    };
  });
}

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

export function ProbePage() {
  const [probeId] = useState(loadOrCreateProbeId);
  // Shares its override with useClockTrust (the PRN screen's server-time check) rather than
  // keeping its own separate one: setting the API URL here used to have no effect on that check
  // at all, which made this field a confusing dead end when the two ever needed to agree.
  const [apiBaseUrl, setApiBaseUrlState] = useState(getApiBaseUrl);

  const [environment, setEnvironment] = useState<EnvironmentSnapshot | null>(null);
  const [storageResult, setStorageResult] = useState<StorageCheckResult | null>(null);
  const [storageChecking, setStorageChecking] = useState(false);

  const timerProbeRef = useRef(createTimerSurvivalProbe());
  const [timerRunning, setTimerRunning] = useState(false);
  const [timerResult, setTimerResult] = useState<TimerSurvivalResult | null>(null);

  const [vapidPublicKey, setVapidPublicKey] = useState<string | null>(null);
  const [vapidError, setVapidError] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<PushSubscriptionJSON | null>(null);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);
  const [subscribing, setSubscribing] = useState(false);

  const [delaySeconds, setDelaySeconds] = useState(20);
  const [scheduling, setScheduling] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [lastSchedule, setLastSchedule] = useState<ScheduleBurstResult | null>(null);

  const [serverLog, setServerLog] = useState<ProbePushLog | null>(null);
  const [receipts, setReceipts] = useState<ProbePushReceipt[]>([]);

  const persistApiBaseUrl = useCallback((value: string) => {
    setApiBaseUrlState(value);
    setApiBaseUrl(value);
  }, []);

  const refreshEnvironment = useCallback(() => {
    setEnvironment(snapshotEnvironment(window));
  }, []);

  useEffect(() => {
    refreshEnvironment();
  }, [refreshEnvironment]);

  const loadVapidKey = useCallback(async () => {
    setVapidError(null);
    try {
      setVapidPublicKey(await fetchVapidPublicKey(apiBaseUrl));
    } catch (error) {
      setVapidPublicKey(null);
      setVapidError(error instanceof Error ? error.message : String(error));
    }
  }, [apiBaseUrl]);

  const refreshResults = useCallback(async () => {
    const [log, local] = await Promise.all([
      fetchServerLog(apiBaseUrl, probeId).catch(() => null),
      getReceipts(),
    ]);
    setServerLog(log);
    setReceipts(local);
  }, [apiBaseUrl, probeId]);

  useEffect(() => {
    void loadVapidKey();
    void refreshResults();
  }, [loadVapidKey, refreshResults]);

  // Best-effort live update: only fires if the page is open when the push arrives, which is
  // not the case being tested, but it's free and makes the demo feel responsive when it does.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const handler = (event: MessageEvent) => {
      const data = event.data as { kind?: string } | undefined;
      if (data?.kind === 'probe-push-receipt') void refreshResults();
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [refreshResults]);

  const handleCheckStorage = useCallback(async () => {
    setStorageChecking(true);
    try {
      setStorageResult(await checkStoragePersistence(navigator.storage));
    } finally {
      setStorageChecking(false);
    }
  }, []);

  const handleStartTimer = useCallback(() => {
    timerProbeRef.current.start();
    setTimerRunning(true);
    setTimerResult(null);
  }, []);

  const handleStopTimer = useCallback(() => {
    setTimerResult(timerProbeRef.current.stop());
    setTimerRunning(false);
  }, []);

  const handleRequestPermission = useCallback(async () => {
    if (!environment?.notificationSupported) return;
    await Notification.requestPermission();
    refreshEnvironment();
  }, [environment?.notificationSupported, refreshEnvironment]);

  const handleSubscribe = useCallback(async () => {
    if (!vapidPublicKey) return;
    setSubscribing(true);
    setSubscribeError(null);
    try {
      setSubscription(await subscribeToPush(vapidPublicKey));
    } catch (error) {
      setSubscribeError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubscribing(false);
    }
  }, [vapidPublicKey]);

  const handleSchedule = useCallback(
    async (burstCount: number, spacingMs: number, options?: ProbeNotificationOptions) => {
      if (!subscription) return;
      setScheduling(true);
      setScheduleError(null);
      try {
        const result = await scheduleBurst(apiBaseUrl, {
          probeId,
          subscription,
          delaySeconds,
          burstCount,
          spacingMs,
          options,
        });
        setLastSchedule(result);
        await refreshResults();
      } catch (error) {
        setScheduleError(error instanceof Error ? error.message : String(error));
      } finally {
        setScheduling(false);
      }
    },
    [apiBaseUrl, delaySeconds, probeId, refreshResults, subscription],
  );

  const handleClearReceipts = useCallback(async () => {
    await clearReceipts();
    setReceipts([]);
  }, []);

  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const merged = mergeResults(serverLog, receipts);
  const summaryText = JSON.stringify(
    {
      probeId,
      apiBaseUrl,
      environment,
      storageResult,
      timerResult,
      merged,
      rawServerLog: serverLog,
      rawLocalReceipts: receipts,
    },
    null,
    2,
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(summaryText);
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }
  }, [summaryText]);

  return (
    <main className="mx-auto flex min-h-full max-w-2xl flex-col gap-6 p-4">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">MedGuard</h1>
        <p className="text-sm text-slate-400">Capability probe &amp; diagnostics</p>
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
                Screen, then reopen from there before testing push below.
              </p>
            )}
          </div>
        )}
        <button type="button" className={buttonClass} onClick={refreshEnvironment}>
          Refresh
        </button>
      </Section>

      <Section title="2. Storage persistence">
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
              Quota: {storageResult.quotaBytes ?? '—'} bytes, usage: {storageResult.usageBytes ?? '—'} bytes
            </div>
          </div>
        )}
      </Section>

      <Section title="3. Background timer survival">
        <p className="text-sm text-slate-400">
          Start this, then background the tab or lock the phone for a couple of minutes, and come
          back. Large gaps between ticks show where the OS suspended execution.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className={buttonClass}
            onClick={handleStartTimer}
            disabled={timerRunning}
          >
            Start (5s ticks)
          </button>
          <button
            type="button"
            className={buttonClass}
            onClick={handleStopTimer}
            disabled={!timerRunning}
          >
            Stop &amp; show results
          </button>
        </div>
        {timerResult && (
          <div className="text-sm">
            <div>Ticks recorded: {timerResult.tickCount}</div>
            <div>Largest gap: {timerResult.maxGapMs} ms (expected ~{timerResult.expectedIntervalMs} ms)</div>
          </div>
        )}
      </Section>

      <Section title="4. Push delivery">
        <label className="flex flex-col gap-1 text-sm">
          API base URL
          <input
            className={inputClass}
            value={apiBaseUrl}
            onChange={(event) => persistApiBaseUrl(event.target.value)}
            placeholder="https://medguard-api.<subdomain>.workers.dev"
          />
        </label>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>VAPID key: {vapidPublicKey ? 'loaded' : vapidError ? 'failed to load' : 'loading…'}</span>
          <button type="button" className={buttonClass} onClick={() => void loadVapidKey()}>
            Retry
          </button>
        </div>
        {vapidError && <p className="text-locked text-sm">{vapidError}</p>}

        <button
          type="button"
          className={buttonClass}
          onClick={() => void handleRequestPermission()}
          disabled={!environment?.notificationSupported || environment.notificationPermission === 'granted'}
        >
          Enable notifications
        </button>

        <button
          type="button"
          className={buttonClass}
          onClick={() => void handleSubscribe()}
          disabled={!vapidPublicKey || environment?.notificationPermission !== 'granted' || subscribing}
        >
          {subscribing ? 'Subscribing…' : subscription ? 'Re-subscribe' : 'Subscribe to push'}
        </button>
        {subscribeError && <p className="text-locked text-sm">{subscribeError}</p>}
        {subscription && <p className="text-safe text-sm">Subscribed.</p>}

        <label className="flex flex-col gap-1 text-sm">
          Delay before sending (seconds) — lock the phone during this window
          <input
            type="number"
            className={inputClass}
            value={delaySeconds}
            min={0}
            onChange={(event) => setDelaySeconds(Number(event.target.value))}
          />
        </label>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={!subscription || scheduling}
            onClick={() => void handleSchedule(1, 0)}
          >
            Send single push
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!subscription || scheduling}
            onClick={() => void handleSchedule(SHABBAT_BURST_COUNT, SHABBAT_BURST_SPACING_MS)}
          >
            Send Shabbat burst ({SHABBAT_BURST_COUNT}×, {(SHABBAT_BURST_SPACING_MS / 1000).toFixed(1)}s apart)
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!subscription || scheduling}
            onClick={() => void handleSchedule(1, 0, { sound: 'alert.mp3' })}
          >
            Send with custom sound (tests whether the browser keeps it)
          </button>
        </div>
        {scheduleError && <p className="text-locked text-sm">{scheduleError}</p>}
        {lastSchedule && (
          <p className="text-sm text-slate-400">
            Scheduled {lastSchedule.scheduled} push(es), first due {lastSchedule.firstDueAtIso}.
          </p>
        )}
      </Section>

      <Section title="5. Results">
        <div className="flex gap-2">
          <button type="button" className={buttonClass} onClick={() => void refreshResults()}>
            Refresh results
          </button>
          <button type="button" className={buttonClass} onClick={() => void handleClearReceipts()}>
            Clear local receipts
          </button>
        </div>

        {merged.length === 0 ? (
          <p className="text-sm text-slate-400">No results yet — send a push above, then refresh.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-slate-400">
                  <th className="pr-3">#</th>
                  <th className="pr-3">Server sent</th>
                  <th className="pr-3">Received on device</th>
                  <th className="pr-3">Latency</th>
                  <th className="pr-3">Retained options</th>
                </tr>
              </thead>
              <tbody>
                {merged.map((row) => (
                  <tr key={row.serverSentAtIso}>
                    <td className="pr-3">
                      {row.burstIndex}/{row.burstTotal}
                    </td>
                    <td className="pr-3">
                      <Badge ok={row.serverOk} label={String(row.serverStatus)} />
                    </td>
                    <td className="pr-3">
                      {row.receivedAtIso ? (
                        <span className="text-safe">yes</span>
                      ) : (
                        <span className="text-locked">not yet seen</span>
                      )}
                    </td>
                    <td className="pr-3">
                      {row.deliveryLatencyMs !== null ? `${row.deliveryLatencyMs} ms` : '—'}
                    </td>
                    <td className="pr-3">
                      {row.retainedOptions ? row.retainedOptions.join(', ') || 'none' : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center gap-2">
          <button type="button" className={buttonClass} onClick={() => void handleCopy()}>
            Copy full results
          </button>
          {copyStatus === 'copied' && <span className="text-safe text-sm">Copied.</span>}
          {copyStatus === 'error' && (
            <span className="text-locked text-sm">Clipboard blocked — select the text below manually.</span>
          )}
        </div>
        <textarea readOnly className="h-40 w-full rounded-md bg-slate-900 p-2 font-mono text-xs" value={summaryText} />
      </Section>
    </main>
  );
}
