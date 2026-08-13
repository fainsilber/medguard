import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState } from 'react';
import {
  collectReconciliationItems,
  hasUnreconciledDoses,
  nextWindow,
  shabbatPhaseAt,
} from '@medguard/shared';
import { getDismissedReconciliation, setDismissedReconciliation } from '@medguard/store';
import { useClock, useMedGuardDb, useStore } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';

/**
 * Whether the Motzei Shabbat sheet should be taking the screen right now (Sprint A5 phase 2).
 *
 * PRD §3 says the app *opens* the reconciliation sheet after Havdalah rather than waiting to be
 * asked, and that is the behaviour here: doses given during Shabbat are unrecorded until someone
 * says what happened, and a caregiver who has just made Havdalah is not thinking about the app.
 *
 * Dismissal is remembered **per device and per window**, in local-only storage. Per device because
 * one caregiver tapping "Later" must not silently suppress the prompt on the other's phone; per
 * window because the next Shabbat is a different question, and nothing should have to remember to
 * clear a flag.
 */
export function useMotzeiPrompt(): { show: boolean; dismiss: () => void } {
  const db = useMedGuardDb();
  const store = useStore();
  const clock = useClock();
  const householdSettings = useHouseholdSettings();

  const config = useLiveQuery(async () => (await db.shabbatConfig.toArray())[0], [db]);
  const windows = useLiveQuery(() => db.shabbatWindows.toArray(), [db]);
  const schedules = useLiveQuery(() => db.schedules.toArray(), [db]);
  const medicines = useLiveQuery(() => db.medicines.toArray(), [db]);
  const logs = useLiveQuery(() => db.intakeLogs.toArray(), [db]);

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

  const nowMs = clock.nowMs();
  const timeZone = householdSettings?.timeZone;

  const ready =
    loadedDismissal &&
    windows !== undefined &&
    schedules !== undefined &&
    medicines !== undefined &&
    logs !== undefined &&
    timeZone !== undefined;

  const items = ready
    ? collectReconciliationItems({ windows, schedules, medicines, logs, timeZone, nowMs })
    : [];

  const phase = ready
    ? shabbatPhaseAt({
        config,
        windows,
        atMs: nowMs,
        hasUnreconciledDoses: hasUnreconciledDoses(items),
      })
    : 'weekday';

  // Identified by the window that just ended — the one the doses belong to. `nextWindow` finds
  // what is coming; this is its opposite, and the id a dismissal is remembered against.
  const endedWindow = ready
    ? [...windows]
        .filter((window) => new Date(window.endsAt).getTime() <= nowMs)
        .sort((a, b) => new Date(b.endsAt).getTime() - new Date(a.endsAt).getTime())[0]
    : undefined;

  const dismiss = useCallback(() => {
    if (!endedWindow) return;
    setDismissedWindowId(endedWindow.id);
    void setDismissedReconciliation(store, endedWindow.id);
  }, [endedWindow, store]);

  const show =
    phase === 'motzei_pending' &&
    endedWindow !== undefined &&
    dismissedWindowId !== endedWindow.id &&
    // Never mid-Shabbat, even if a stale window somehow says otherwise.
    nextWindow(windows ?? [], nowMs)?.id !== endedWindow.id;

  return { show, dismiss };
}
