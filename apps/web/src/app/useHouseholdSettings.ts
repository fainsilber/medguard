import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect } from 'react';
import type { HouseholdSettings } from '@medguard/shared';
import { useMedGuardDb, useRepository } from './RepositoryContext.js';

/**
 * Defaults matching the PRD (§4: 15-minute escalation, configurable snooze) and the browser's
 * own timezone — bootstrapping, like device id and caregiver name, not a domain decision. This
 * stands in for a real settings screen until Sprint 6 needs one for Shabbat coordinates; nothing
 * here is final, just a reasonable starting point that requires no manual setup to use the app.
 */
const DEFAULT_ESCALATION_MINUTES = 15;
const DEFAULT_SNOOZE_MINUTES = 15;

function detectTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * The household's fixed timezone and related settings, creating a sensible default on first run
 * if none exists yet. Every wall-clock computation in the app (schedule expansion, the Today
 * view, PRN countdowns) resolves against this rather than the device's own timezone, so a
 * caregiver travelling doesn't shift every dose time (PRD §1).
 */
export function useHouseholdSettings(): HouseholdSettings | undefined {
  const db = useMedGuardDb();
  const repository = useRepository();
  const settings = useLiveQuery(() => db.householdSettings.get('household'), [db]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const existing = await db.householdSettings.get('household');
      if (cancelled || existing) {
        return;
      }
      await repository.saveHouseholdSettings(
        {
          id: 'household',
          timeZone: detectTimeZone(),
          escalationAfterMinutes: DEFAULT_ESCALATION_MINUTES,
          snoozeMinutes: DEFAULT_SNOOZE_MINUTES,
          // Overwritten by the repository's own stamp; placeholders satisfy the type.
          updatedAt: '',
          updatedByDeviceId: '',
          syncStatus: 'pending',
        },
        'CREATE',
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [db, repository]);

  return settings;
}
