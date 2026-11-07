import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import type { LiveMessage, LiveSafetyWarningMessage } from '@medguard/shared';
import { LiveClient, SyncApiError, SyncEngine } from '@medguard/store';
import type { LiveClientStatus } from '@medguard/store';
import { getApiBaseUrl } from '../api/config.js';
import * as syncApi from '../api/syncApi.js';
import { useRepository, useStore } from '../app/RepositoryContext.js';
import { clearHouseholdSession, getHouseholdSession, onHouseholdSessionChange } from '../identity/session.js';
import type { HouseholdSession } from '../identity/session.js';
import { appLog } from '../logging/appLog.js';
import { useLiveQuery } from '../store/useLiveQuery.js';
import {
  registerBackgroundSync,
  setForegroundSyncRunner,
  unregisterBackgroundSync,
} from './backgroundSync.js';

const log = appLog('sync');
const liveLog = appLog('live');

/**
 * A failed round is retried on its own this many times, with these delays, before the failure is
 * shown ("Sync failed"). After that nothing retries until a new trigger: a tap on the badge, the
 * app returning to the foreground, the live channel reopening, a server `sync` message, or a new
 * local write.
 */
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;
const MAX_AUTO_RETRIES = RETRY_DELAYS_MS.length;

/**
 * `auto`: a normal trigger — resets the retry budget. `manual`: the caregiver tapped the badge —
 * a single attempt whose failure is shown right away, since they are watching. `retry`: the
 * provider's own scheduled retry — keeps counting.
 */
type SyncMode = 'auto' | 'manual' | 'retry';

/**
 * Starts and stops the sync engine and live WebSocket as the household connection comes and
 * goes, and exposes a status every screen can show — safety invariant 6. The Android equivalent
 * of `apps/web/src/sync/SyncProvider.tsx`: same `SyncEngine`/`LiveClient` from `@medguard/store`,
 * same state machine, but the household session is read asynchronously (`expo-secure-store`) and
 * "a new local write happened" is detected via `useLiveQuery` over the `NotifyingStore` instead
 * of Dexie's `useLiveQuery(() => db.syncOutbox.count(), [db])`.
 */

export type SyncIndicatorStatus =
  | { kind: 'disconnected' }
  | { kind: 'offline' }
  | { kind: 'syncing' }
  /** A round failed and the provider is waiting to retry on its own — `attempt` is the upcoming
   * retry's number (1-based) out of `max`. Not yet shown as an error. */
  | { kind: 'retrying'; attempt: number; max: number }
  | { kind: 'synced' }
  | { kind: 'pending'; count: number }
  | { kind: 'error'; message: string }
  /** This device's token was revoked (by another caregiver, from the Household screen) — not a
   * transient failure, so shown distinctly from `'error'` rather than as one more sync-error
   * message. Sticky until the caregiver responds via `clearRevokedDevice` or joins a different
   * household; every further sync attempt will keep failing the exact same way. */
  | { kind: 'revoked' };

interface SyncContextValue {
  status: SyncIndicatorStatus;
  lastSafetyWarning: LiveSafetyWarningMessage | null;
  dismissSafetyWarning: () => void;
  /** Runs a sync round now — what tapping the status badge does. A no-op with no household or
   * once this device has been revoked. */
  syncNow: () => Promise<void>;
  /**
   * Wipes this device's local medical data and forgets the household session — the caregiver's
   * own confirmed response to a `'revoked'` status. Mirrors `HouseholdScreen`'s "Leave" flow
   * (`disconnectLocally`), but usable when this device's token no longer works against the server
   * at all, so it cannot go through `leaveHousehold()`'s API round-trip first. Deliberately not
   * automatic on the first `'unauthorized'` response: a caregiver should see and confirm this,
   * not have their device's data disappear out from under them on what could in principle be a
   * transient/misconfigured 401.
   */
  clearRevokedDevice: () => Promise<void>;
}

const SyncReactContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  const repository = useRepository();

  const [session, setSession] = useState<HouseholdSession | null | undefined>(undefined);
  const [connectionStatus, setConnectionStatus] = useState<LiveClientStatus>('closed');
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryAttempt, setRetryAttempt] = useState<number | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [lastSafetyWarning, setLastSafetyWarning] = useState<LiveSafetyWarningMessage | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void getHouseholdSession().then((value) => {
        if (!cancelled) {
          setSession(value);
        }
      });
    };
    refresh();
    const unsubscribe = onHouseholdSessionChange(refresh);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Called from the outbox-watching effect below, so a caregiver's own new dose is pushed right
  // away rather than waiting for the next WebSocket event or reconnect to happen to trigger one.
  const runSyncRef = useRef<(mode?: SyncMode) => Promise<void>>(async () => {});

  useEffect(() => {
    if (session === undefined) {
      // Still loading the session from expo-secure-store — nothing to start yet.
      return;
    }
    if (!session) {
      setConnectionStatus('closed');
      setError(null);
      setRevoked(false);
      setRetryAttempt(null);
      setPendingCount(0);
      runSyncRef.current = async () => {};
      // Left the household (or was removed and cleared): nothing to sync in the background.
      void unregisterBackgroundSync();
      return;
    }

    // A fresh session (first load, or a different household after `clearRevokedDevice`/leaving)
    // must not inherit a previous session's error/revoked state.
    setError(null);
    setRevoked(false);
    setRetryAttempt(null);

    let cancelled = false;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const clearRetryTimer = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
    const engine = new SyncEngine({
      store,
      repository,
      api: syncApi,
      apiBaseUrl: getApiBaseUrl(),
      deviceToken: session.deviceToken,
      householdId: session.householdId,
      log,
    });

    const refreshPendingCount = async () => {
      const count = await repository.pendingSyncCount();
      if (!cancelled) {
        setPendingCount(count);
      }
    };

    const runSync = async (mode: SyncMode = 'auto') => {
      if (mode !== 'retry') {
        // Any new trigger supersedes a pending scheduled retry. A manual attempt gets no
        // automatic retries of its own — its failure is shown immediately.
        clearRetryTimer();
        retryCount = mode === 'manual' ? MAX_AUTO_RETRIES : 0;
        if (mode === 'manual' && !cancelled) {
          setError(null);
          setRetryAttempt(null);
        }
      }
      setSyncing(true);
      try {
        await engine.runOnce();
        retryCount = 0;
        if (!cancelled) {
          setError(null);
          setRetryAttempt(null);
        }
      } catch (err) {
        if (err instanceof SyncApiError && err.code === 'unauthorized') {
          log.error('sync round failed: device revoked', { message: err.message });
          clearRetryTimer();
          if (!cancelled) {
            setRevoked(true);
            setRetryAttempt(null);
          }
        } else {
          const message = err instanceof Error ? err.message : 'Sync failed';
          log.error('sync round failed', { message });
          if (cancelled) {
            // Torn down mid-round — nothing to show or schedule.
          } else if (retryCount < MAX_AUTO_RETRIES) {
            const delay = RETRY_DELAYS_MS[retryCount] ?? RETRY_DELAYS_MS[MAX_AUTO_RETRIES - 1];
            retryCount += 1;
            setError(null);
            setRetryAttempt(retryCount);
            log.info('retrying sync', { attempt: retryCount, delayMs: delay });
            clearRetryTimer();
            retryTimer = setTimeout(() => {
              retryTimer = null;
              void runSync('retry');
            }, delay);
          } else {
            setRetryAttempt(null);
            setError(message);
          }
        }
      } finally {
        if (!cancelled) {
          setSyncing(false);
        }
        await refreshPendingCount();
      }
    };
    runSyncRef.current = runSync;
    // If the OS wakes the app's JS for a periodic background sync while this provider is alive,
    // run through this engine rather than opening a second one on the same database.
    setForegroundSyncRunner(() => runSync('auto'));
    void registerBackgroundSync();

    const handleMessage = (message: LiveMessage) => {
      if (message.type === 'sync') {
        void runSync();
      } else if (message.type === 'safety.warning' && !cancelled) {
        setLastSafetyWarning(message);
      }
    };

    const liveClient = new LiveClient({
      apiBaseUrl: getApiBaseUrl(),
      deviceToken: session.deviceToken,
      onStatusChange: (status) => {
        if (cancelled) return;
        setConnectionStatus(status);
        if (status === 'open') {
          void runSync();
        }
      },
      onMessage: handleMessage,
      log: liveLog,
    });
    liveClient.start();
    void runSync();

    return () => {
      cancelled = true;
      clearRetryTimer();
      liveClient.stop();
      runSyncRef.current = async () => {};
      setForegroundSyncRunner(null);
    };
    // store/repository are stable for the lifetime of RepositoryProvider — only a different
    // household session should tear down and rebuild the connection.
  }, [session, store, repository]);

  // Reactively drains whenever a new local mutation is queued — the sync engine otherwise has no
  // way to learn "something changed" except a WebSocket event *from the server*, which is exactly
  // backwards for the device that just made the change itself.
  const outboxCount = useLiveQuery(() => repository.pendingSyncCount(), ['syncOutbox']);
  const previousOutboxCount = useRef(0);

  useEffect(() => {
    previousOutboxCount.current = 0;
  }, [session]);

  useEffect(() => {
    if (!session || outboxCount === undefined) {
      return;
    }
    if (outboxCount > previousOutboxCount.current) {
      void runSyncRef.current();
    }
    previousOutboxCount.current = outboxCount;
  }, [session, outboxCount]);

  // Coming back to the foreground is the moment a caregiver is most likely to be looking at
  // stale data — sync rather than waiting for the next live-channel event.
  useEffect(() => {
    if (!session) {
      return;
    }
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void runSyncRef.current('auto');
      }
    });
    return () => subscription.remove();
  }, [session]);

  const status: SyncIndicatorStatus = !session
    ? { kind: 'disconnected' }
    : revoked
      ? { kind: 'revoked' }
      : error
        ? { kind: 'error', message: error }
        : retryAttempt !== null
          ? { kind: 'retrying', attempt: retryAttempt, max: MAX_AUTO_RETRIES }
          : syncing
            ? { kind: 'syncing' }
            : connectionStatus !== 'open'
              ? { kind: 'offline' }
              : pendingCount > 0
                ? { kind: 'pending', count: pendingCount }
                : { kind: 'synced' };

  const clearRevokedDevice = async () => {
    await repository.clearAllData();
    await clearHouseholdSession();
  };

  return (
    <SyncReactContext.Provider
      value={{
        status,
        lastSafetyWarning,
        dismissSafetyWarning: () => setLastSafetyWarning(null),
        syncNow: () => runSyncRef.current('manual'),
        clearRevokedDevice,
      }}
    >
      {children}
    </SyncReactContext.Provider>
  );
}

export function useSyncStatus(): SyncContextValue {
  const ctx = useContext(SyncReactContext);
  if (!ctx) {
    throw new Error('useSyncStatus must be used within a SyncProvider');
  }
  return ctx;
}
