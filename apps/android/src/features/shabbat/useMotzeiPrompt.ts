import { useCallback, useEffect, useState } from 'react';
import { collectReconciliationItems, hasUnreconciledDoses, shabbatPhaseAt } from '@medguard/shared';
import type { IntakeLog, Medicine, Schedule, ShabbatConfig, ShabbatWindow } from '@medguard/shared';
import { getDismissedReconciliation, setDismissedReconciliation } from '@medguard/store';
import { useClock, useRepository, useStore } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';

/**
 * RN port of `apps/web/src/features/shabbat/useMotzeiPrompt.ts` — whether the reconciliation sheet
 * should be taking the screen right now (PRD §3, Sprint A5 phase 2).
 *
 * Same rules, and for the same reasons: dismissal is remembered per device (one caregiver tapping
 * "Later" must not suppress the prompt on the other's phone) and per window (the next Shabbat is a
 * different question, and nothing should have to remember to clear a flag).
 */

/**
 * Raw inputs only. Anything derived inside `useLiveQuery` would freeze at whatever the household
 * timezone was on first render, because it re-runs on *store* changes and the timezone arrives a
 * tick after mount.
 */
interface PromptData {
  windows: ShabbatWindow[];
  config: ShabbatConfig | undefined;
  schedules: Schedule[];
  medicines: Medicine[];
  logs: IntakeLog[];
}

export function useMotzeiPrompt(): { show: boolean; dismiss: () => void } {
  const repository = useRepository();
  const store = useStore();
  const clock = useClock();
  const householdSettings = useHouseholdSettings();

  const [dismissedWindowId, setDismissedWindowId] = useState<string | undefined>(undefined);
  const [loadedDismissal, setLoadedDismissal] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getDismissedReconciliation(store).then((value) => {
      if (!cancelled) {
        setDismissedWindowId(value);
        setLoadedDismissal(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [store]);

  const timeZone = householdSettings?.timeZone;
  const nowMs = clock.nowMs();

  const data = useLiveQuery<PromptData>(
    async () => ({
      // Sequential rather than Promise.all, like `AlarmEngine.reconcileExclusive`: each of these
      // opens its own transaction, and expo-sqlite's single connection does not promise that
      // overlapping ones are safe.
      windows: await repository.allShabbatWindows(),
      config: await repository.getShabbatConfig(),
      schedules: await repository.allSchedules(),
      medicines: await repository.allMedicines(),
      logs: await repository.allLogs(),
    }),
    ['shabbatWindows', 'shabbatConfig', 'schedules', 'medicines', 'intakeLogs'],
  );

  const ready = loadedDismissal && data !== undefined && timeZone !== undefined;

  const items = ready
    ? collectReconciliationItems({
        windows: data.windows,
        schedules: data.schedules,
        medicines: data.medicines,
        logs: data.logs,
        timeZone,
        nowMs,
      })
    : [];

  const phase = ready
    ? shabbatPhaseAt({
        config: data.config,
        windows: data.windows,
        atMs: nowMs,
        hasUnreconciledDoses: hasUnreconciledDoses(items),
      })
    : 'weekday';

  // The window the unreconciled doses belong to: the most recent one that has ended.
  const endedWindow = ready
    ? [...data.windows]
        .filter((window) => new Date(window.endsAt).getTime() <= nowMs)
        .sort((a, b) => new Date(b.endsAt).getTime() - new Date(a.endsAt).getTime())[0]
    : undefined;

  const dismiss = useCallback(() => {
    if (!endedWindow) return;
    setDismissedWindowId(endedWindow.id);
    void setDismissedReconciliation(store, endedWindow.id);
  }, [endedWindow, store]);

  const show =
    phase === 'motzei_pending' && endedWindow !== undefined && dismissedWindowId !== endedWindow.id;

  return { show, dismiss };
}
