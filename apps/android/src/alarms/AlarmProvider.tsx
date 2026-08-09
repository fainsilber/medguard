import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import * as MedGuardAlarms from '../../modules/medguard-alarms/src';
import {
  useClock,
  useCurrentDeviceId,
  useCurrentUserId,
  useIdGenerator,
  useRepository,
  useStore,
} from '../app/RepositoryContext.js';
import { getApiBaseUrl } from '../api/config.js';
import { request } from '../api/householdApi.js';
import { getHouseholdSession } from '../identity/session.js';
import { appLog } from '../logging/appLog.js';
import { AlarmEngine } from './AlarmEngine.js';
import { registerForPush } from './pushRegistration.js';
import type { AlarmEngineState } from './AlarmEngine.js';
import type { AlarmHealth, SyncStaleness } from './alarmHealth.js';

const log = appLog('alarms');

/**
 * Starts the local alarm engine and keeps it reconciled — the Android equivalent of
 * `SyncProvider`, and deliberately mounted just inside it (`App.tsx`) rather than beside it: the
 * whole point of re-materializing "on every sync pull" is that `SyncProvider`'s writes go through
 * the same `NotifyingStore` this subscribes to, so nesting needs no explicit hook between them.
 */

const WATCHED_TABLES = ['schedules', 'intakeLogs', 'doseSnoozes', 'householdSettings', 'medicines'] as const;

/** Independent store-change notifications inside one sync pull collapse to one reconcile. */
const RECONCILE_DEBOUNCE_MS = 500;

interface AlarmContextValue {
  health: AlarmHealth | undefined;
  staleness: SyncStaleness | undefined;
  snooze: (occurrenceKey: string) => Promise<void>;
}

const AlarmReactContext = createContext<AlarmContextValue | null>(null);

export function AlarmProvider({ children }: { children: ReactNode }) {
  const repository = useRepository();
  const store = useStore();
  const clock = useClock();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();

  const [state, setState] = useState<AlarmEngineState | undefined>(undefined);

  // Read by the engine when it derives alarm health, so "the server cannot reach this device"
  // shows up in the same place every other degradation does. Undefined until the first attempt
  // finishes — see `isPushRegistered` on `AlarmEngineDeps` for why that is not `false`.
  const pushRegisteredRef = useRef<boolean | undefined>(undefined);

  const engineRef = useRef<AlarmEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new AlarmEngine({
      repository,
      store,
      native: MedGuardAlarms,
      clock,
      ids,
      userId,
      deviceId,
      isPushRegistered: () => pushRegisteredRef.current,
      log,
    });
  }

  useEffect(() => {
    let cancelled = false;
    const engine = engineRef.current!;

    const reconcile = () => {
      void engine.reconcile().then((next) => {
        if (!cancelled) {
          setState(next);
        }
      });
    };

    const applyThenReconcile = () => {
      // applyPendingActions() reconciles internally once it's done, so this alone covers both a
      // fresh app launch (a tap captured while the process was dead) and a foreground resume.
      void engine.applyPendingActions().then((applied) => {
        if (!cancelled && applied === 0) {
          // No pending action to react to — still reconcile, since a foreground resume is also
          // when a phone that was locked and offline is most likely to have just regained signal.
          reconcile();
        }
      });
    };

    applyThenReconcile();

    const appStateSubscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        applyThenReconcile();
      }
    });

    // Fires when a tap lands while this JS runtime is alive — the common case for a merely-locked
    // phone. A dead process still captures the tap durably; it is picked up by the launch/
    // foreground path above instead.
    const pendingActionSubscription = MedGuardAlarms.addPendingActionListener(() => {
      applyThenReconcile();
    });

    let debounceHandle: ReturnType<typeof setTimeout> | null = null;
    const unsubscribeStore = store.subscribe(WATCHED_TABLES, () => {
      if (debounceHandle) {
        clearTimeout(debounceHandle);
      }
      debounceHandle = setTimeout(reconcile, RECONCILE_DEBOUNCE_MS);
    });

    return () => {
      cancelled = true;
      appStateSubscription.remove();
      pendingActionSubscription.remove();
      unsubscribeStore();
      if (debounceHandle) {
        clearTimeout(debounceHandle);
      }
    };
    // The engine instance is stable for the provider's lifetime (see the ref above); re-running
    // this effect on every render would tear down and rebuild every listener for nothing.
  }, [store]);

  /**
   * Registers this device for the server's push backstop (Sprint A4).
   *
   * Separate from the reconcile effect above because it depends on something else entirely — the
   * household session — and because it must survive Firebase rotating the token at any moment,
   * which is what the `onPushToken` listener covers. Every outcome is reported through alarm
   * health rather than raised as an error: a household with no Firebase project configured is a
   * supported configuration, not a broken one.
   */
  useEffect(() => {
    let cancelled = false;

    const register = async () => {
      const session = await getHouseholdSession();
      if (!session || cancelled) {
        return;
      }

      const outcome = await registerForPush({
        apiBaseUrl: getApiBaseUrl(),
        deviceToken: session.deviceToken,
        getPushToken: MedGuardAlarms.getPushToken,
        post: (url, options) => request('POST', url, options),
      });
      if (cancelled) {
        return;
      }

      pushRegisteredRef.current = outcome.kind === 'registered';
      if (outcome.kind !== 'registered') {
        log.debug('no server push backstop on this device', { outcome: outcome.kind });
      }
      // Re-derive health so the banner and the ongoing notification reflect what just happened.
      void engineRef.current!.reconcile().then((next) => {
        if (!cancelled) {
          setState(next);
        }
      });
    };

    void register();
    const tokenSubscription = MedGuardAlarms.addPushTokenListener(() => void register());

    return () => {
      cancelled = true;
      tokenSubscription.remove();
    };
  }, []);

  const snooze = async (occurrenceKey: string) => {
    await engineRef.current!.snooze(occurrenceKey);
  };

  return (
    <AlarmReactContext.Provider value={{ health: state?.health, staleness: state?.staleness, snooze }}>
      {children}
    </AlarmReactContext.Provider>
  );
}

export function useAlarmHealth(): AlarmContextValue {
  const ctx = useContext(AlarmReactContext);
  if (!ctx) {
    throw new Error('useAlarmHealth must be used within an AlarmProvider');
  }
  return ctx;
}
