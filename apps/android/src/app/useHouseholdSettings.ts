import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect } from 'react';
import type { HouseholdSettings } from '@medguard/shared';
import { useMedGuardDb, useRepository } from './AndroidAppProvider.js';

/**
 * The household's fixed timezone and related settings, creating a sensible default on first run.
 *
 * Every wall-clock computation in the app (schedule expansion, the Today view) resolves against
 * this rather than the device's own timezone, so a caregiver travelling does not shift every
 * dose time (PRD §1). Defaults match `apps/web/src/app/useHouseholdSettings.ts`.
 */
const DEFAULT_ESCALATION_MINUTES = 15;
const DEFAULT_SNOOZE_MINUTES = 15;

function detectTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

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
