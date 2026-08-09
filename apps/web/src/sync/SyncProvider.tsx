import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LiveMessage, LiveSafetyWarningMessage } from '@medguard/shared';
import { LiveClient, SyncApiError, SyncEngine } from '@medguard/store';
import type { LiveClientStatus } from '@medguard/store';
import * as syncApi from '../api/syncApi.js';
import { getApiBaseUrl } from '../api/config.js';
import { clearHouseholdSession, getHouseholdSession, onHouseholdSessionChange } from '../api/session.js';
import { useMedGuardDb, useRepository, useStore } from '../app/RepositoryContext.js';
import { appLog } from '../logging/appLog.js';

const log = appLog('sync');
const liveLog = appLog('live');

/**
 * Starts and stops the sync engine and live WebSocket as the household connection comes and
 * goes, and exposes a status every screen can show — safety invariant 6: sync state is never
 * silent, whether that's "synced", "3 changes waiting to upload", or "can't reach the server".
 */

export type SyncIndicatorStatus =
  | { kind: 'disconnected' }
  | { kind: 'offline' }
  | { kind: 'syncing' }
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
  /**
   * Wipes this device's local medical data and forgets the household session — the caregiver's
   * own confirmed response to a `'revoked'` status. Mirrors `HouseholdScreen`'s "Leave" flow
   * (`disconnectLocally`), but usable when this device's token no longer works against the server
   * at all, so it cannot go through `leaveHousehold()`'s API round-trip first. Deliberately not
   * automatic on the first `'unauthorized'` response: a caregiver should see and confirm this, not
   * have their device's data disappear out from under them on what could in principle be a
   * transient/misconfigured 401.
   */
  clearRevokedDevice: () => Promise<void>;
}

const SyncReactContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const db = useMedGuardDb();
  const store = useStore();
  const repository = useRepository();

  const [session, setSession] = useState(() => getHouseholdSession());
  const [connectionStatus, setConnectionStatus] = useState<LiveClientStatus>('closed');
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [lastSafetyWarning, setLastSafetyWarning] = useState<LiveSafetyWarningMessage | null>(null);

  useEffect(() => onHouseholdSessionChange(() => setSession(getHouseholdSession())), []);

  // Called from the outbox-watching effect below, so a caregiver's own new dose is pushed right
  // away rather than waiting for the next WebSocket event or reconnect to happen to trigger one.
  const runSyncRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!session) {
      setConnectionStatus('closed');
      setError(null);
      setRevoked(false);
      setPendingCount(0);
      runSyncRef.current = async () => {};
      return;
    }

    // A fresh session (first load, or a different household after `clearRevokedDevice`/leaving)
    // must not inherit a previous session's error/revoked state.
    setError(null);
    setRevoked(false);

    let cancelled = false;
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

    const runSync = async () => {
      setSyncing(true);
      try {
        await engine.runOnce();
        if (!cancelled) {
          setError(null);
        }
      } catch (err) {
        if (err instanceof SyncApiError && err.code === 'unauthorized') {
          log.error('sync round failed: device revoked', { message: err.message });
          if (!cancelled) {
            setRevoked(true);
          }
        } else {
          const message = err instanceof Error ? err.message : 'Sync failed';
          log.error('sync round failed', { message });
          if (!cancelled) {
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
      liveClient.stop();
      runSyncRef.current = async () => {};
    };
    // db/store/repository are memoised per caregiver identity by RepositoryProvider and are not
    // meaningfully "changing" for this effect's purpose — only a different household session
    // should tear down and rebuild the connection.
  }, [session, db, store, repository]);

  // Reactively drains whenever a new local mutation is queued — the sync engine otherwise has no
  // way to learn "something changed" except a WebSocket event *from the server*, which is exactly
  // backwards for the device that just made the change itself.
  const outboxCount = useLiveQuery(() => db.syncOutbox.count(), [db]);
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

  const status: SyncIndicatorStatus = !session
    ? { kind: 'disconnected' }
    : revoked
      ? { kind: 'revoked' }
      : error
        ? { kind: 'error', message: error }
        : syncing
          ? { kind: 'syncing' }
          : connectionStatus !== 'open'
            ? { kind: 'offline' }
            : pendingCount > 0
              ? { kind: 'pending', count: pendingCount }
              : { kind: 'synced' };

  const clearRevokedDevice = async () => {
    await repository.clearAllData();
    clearHouseholdSession();
  };

  return (
    <SyncReactContext.Provider
      value={{
        status,
        lastSafetyWarning,
        dismissSafetyWarning: () => setLastSafetyWarning(null),
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
