import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LiveMessage, LiveSafetyWarningMessage } from '@medguard/shared';
import { getApiBaseUrl } from '../api/config.js';
import { getHouseholdSession, onHouseholdSessionChange } from '../api/session.js';
import { useMedGuardDb, useRepository } from '../app/RepositoryContext.js';
import { SyncEngine } from './engine.js';
import { LiveClient } from './liveClient.js';
import type { LiveClientStatus } from './liveClient.js';

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
  | { kind: 'error'; message: string };

interface SyncContextValue {
  status: SyncIndicatorStatus;
  lastSafetyWarning: LiveSafetyWarningMessage | null;
  dismissSafetyWarning: () => void;
}

const SyncReactContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: ReactNode }) {
  const db = useMedGuardDb();
  const repository = useRepository();

  const [session, setSession] = useState(() => getHouseholdSession());
  const [connectionStatus, setConnectionStatus] = useState<LiveClientStatus>('closed');
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSafetyWarning, setLastSafetyWarning] = useState<LiveSafetyWarningMessage | null>(null);

  useEffect(() => onHouseholdSessionChange(() => setSession(getHouseholdSession())), []);

  // Called from the outbox-watching effect below, so a caregiver's own new dose is pushed right
  // away rather than waiting for the next WebSocket event or reconnect to happen to trigger one.
  const runSyncRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    if (!session) {
      setConnectionStatus('closed');
      setError(null);
      setPendingCount(0);
      runSyncRef.current = async () => {};
      return;
    }

    let cancelled = false;
    const engine = new SyncEngine({
      db,
      repository,
      apiBaseUrl: getApiBaseUrl(),
      deviceToken: session.deviceToken,
      householdId: session.householdId,
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
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Sync failed');
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
    });
    liveClient.start();
    void runSync();

    return () => {
      cancelled = true;
      liveClient.stop();
      runSyncRef.current = async () => {};
    };
    // db/repository are memoised per caregiver identity by RepositoryProvider and are not
    // meaningfully "changing" for this effect's purpose — only a different household session
    // should tear down and rebuild the connection.
  }, [session, db, repository]);

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
