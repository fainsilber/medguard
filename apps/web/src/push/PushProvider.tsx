import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { PendingActionApplier } from '@medguard/store';
import { getApiBaseUrl } from '../api/config.js';
import { getHouseholdSession, onHouseholdSessionChange } from '../api/session.js';
import {
  useClock,
  useCurrentDeviceId,
  useCurrentUserId,
  useIdGenerator,
  useRepository,
} from '../app/RepositoryContext.js';
import { appLog } from '../logging/appLog.js';
import { webPendingActionSource } from './pendingActionStore.js';
import { fetchVapidPublicKey, registerPushSubscription } from './pushApi.js';
import { subscribeToPush } from './pushClient.js';

const log = appLog('push');

/**
 * The two things the app owes the push system, mounted once beside `SyncProvider`.
 *
 * 1. **Keep the server's copy of this device's subscription current.** Browsers rotate
 *    subscriptions without warning and the server has no way to notice until a push is rejected,
 *    so re-registering on every start is the cheap fix — the endpoint is idempotent by design.
 * 2. **Drain captured notification actions.** The service worker parks a lock-screen "Taken" or
 *    "Snooze" as intent (see `pendingActionStore.ts`); this converts it into a real record
 *    through the same repository transaction the UI uses (delta AD2).
 *
 * Both are best-effort and neither blocks rendering: a caregiver whose browser refuses push
 * still has a fully working app, and safety invariant 6's visible-degradation duty is carried by
 * the Diagnostics screen, which shows the registration state rather than failing silently here.
 */
export function PushProvider({ children }: { children: ReactNode }) {
  const repository = useRepository();
  const clock = useClock();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();

  // ---------------------------------------------------------------------
  // Draining captured taps
  // ---------------------------------------------------------------------
  useEffect(() => {
    const applier = new PendingActionApplier({
      repository,
      source: webPendingActionSource,
      clock,
      ids,
      userId,
      deviceId,
      log: { debug: (message, meta) => log.debug(message, meta), error: (message, meta) => log.error(message, meta) },
    });

    const drain = () => {
      void applier.applyPendingActions().catch((error: unknown) => {
        log.error('could not apply captured notification actions', {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    };

    // Three triggers, mirroring the Android engine's: mount (which covers a cold start from
    // tapping a notification), the worker's own nudge for a tap made while a tab was already
    // open, and returning to a backgrounded tab.
    drain();

    const onMessage = (event: MessageEvent) => {
      if ((event.data as { kind?: string } | null)?.kind === 'medguard:pending-action') {
        drain();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        drain();
      }
    };

    navigator.serviceWorker?.addEventListener('message', onMessage);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      navigator.serviceWorker?.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [repository, clock, ids, userId, deviceId]);

  // ---------------------------------------------------------------------
  // Keeping the subscription registered
  // ---------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    const register = async () => {
      const session = getHouseholdSession();
      // Not connected to a household, or the caregiver has never granted permission. Asking here
      // would be a permission prompt on app start, which browsers rightly punish and caregivers
      // rightly distrust — the Diagnostics screen has an explicit button for it instead.
      if (!session || Notification.permission !== 'granted') {
        return;
      }

      const apiBaseUrl = getApiBaseUrl();
      const key = await fetchVapidPublicKey(apiBaseUrl, session.deviceToken);
      if (!key.ok || cancelled) {
        return;
      }

      try {
        const subscription = await subscribeToPush(key.value.publicKey);
        if (cancelled) return;
        const result = await registerPushSubscription(apiBaseUrl, session.deviceToken, subscription);
        if (!result.ok) {
          log.error('could not register this device for push', { error: result.error });
        }
      } catch (error: unknown) {
        log.error('could not subscribe to push', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void register();
    const unsubscribe = onHouseholdSessionChange(() => void register());
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return <>{children}</>;
}
