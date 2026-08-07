import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LiveMessage, LiveSafetyWarningMessage } from '@medguard/shared';
import { LiveClient, SyncEngine } from '@medguard/store';
import type { LiveClientStatus } from '@medguard/store';
import { getApiBaseUrl } from '../api/config.js';
import * as syncApi from '../api/syncApi.js';
import { useRepository, useStore } from '../app/RepositoryContext.js';
import { getHouseholdSession, onHouseholdSessionChange } from '../identity/session.js';
import type { HouseholdSession } from '../identity/session.js';
import { appLog } from '../logging/appLog.js';
import { useLiveQuery } from '../store/useLiveQuery.js';

const log = appLog('sync');
const liveLog = appLog('live');

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
  | { kind: 'synced' }
  | { kind: 'pending'; count: number }
  | { kind: 'error'; message: string };

interface SyncContextValue {
  status: SyncIndicatorStatus;
  lastSafetyWarning: LiveSafetyWarningMessage | null;
  dismissSafetyWarning: () => void;
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
  const runSyncRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (session === undefined) {
      // Still loading the session from expo-secure-store — nothing to start yet.
      return;
    }
    if (!session) {
      setConnectionStatus('closed');
      setError(null);
      setPendingCount(0);
      runSyncRef.current = async () => {};
      return;
    }

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
        const message = err instanceof Error ? err.message : 'Sync failed';
        log.error('sync round failed', { message });
        if (!cancelled) {
          setError(message);
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

  const status: SyncIndicatorStatus = !session
    ? { kind: 'disconnected' }
    : error
      ? { kind: 'error', message: error }
      : syncing
        ? { kind: 'syncing' }
        : connectionStatus !== 'open'
          ? { kind: 'offline' }
          : pendingCount > 0
            ? { kind: 'pending', count: pendingCount }
            : { kind: 'synced' };

  return (
    <SyncReactContext.Provider
      value={{ status, lastSafetyWarning, dismissSafetyWarning: () => setLastSafetyWarning(null) }}
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
