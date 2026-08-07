import { useEffect } from 'react';
import type { HouseholdSettings } from '@medguard/shared';
import { useRepository } from './RepositoryContext.js';
import { useLiveQuery } from '../store/useLiveQuery.js';

/**
 * Defaults matching the PRD (§4: 15-minute escalation, configurable snooze) and the device's own
 * timezone — bootstrapping, like device id and caregiver name, not a domain decision. The Android
 * equivalent of `apps/web/src/app/useHouseholdSettings.ts`, reading through the repository (via
 * `useLiveQuery`) instead of a raw Dexie `db.householdSettings.get(...)` call.
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
  const repository = useRepository();
  const settings = useLiveQuery(() => repository.getHouseholdSettings(), ['householdSettings']);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const existing = await repository.getHouseholdSettings();
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
  }, [repository]);

  return settings;
}
