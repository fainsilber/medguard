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
import { appLog } from '../logging/appLog.js';
import { AlarmEngine } from './AlarmEngine.js';
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
