import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { sequentialIds } from '@medguard/shared/testing';
import type { Clock } from '@medguard/shared';
import { AndroidAppProvider } from '../app/AndroidAppProvider.js';
import { AndroidRepository } from '../db/repository.js';
import { AndroidMedGuardDB } from '../db/schema.js';

/**
 * Test-only infrastructure, not app code — deliberately outside src/app, src/db and
 * src/features, so the no-ambient-time lint rule doesn't apply here the way it does to the code
 * under test.
 *
 * Each call gets its own uniquely-named database, so two renders in the same file never see each
 * other's data.
 */
let databaseCounter = 0;

export interface RenderWithAndroidAppOptions {
  userId?: string;
  /** A fake clock, for anything that needs to drive cooldowns and caps deterministically. */
  clock?: Clock;
  /**
   * Pre-seeds household settings with this timezone before mount. Without it,
   * `useHouseholdSettings` bootstraps from the *host machine's* `Intl` timezone, which differs
   * per machine and CI runner — exactly the non-determinism a test suite cannot have.
   */
  timeZone?: string;
  /** Runs before mount, given a repository for the same database the component will render against. */
  seed?: (repository: AndroidRepository) => Promise<void>;
}

/**
 * Renders `ui` inside a provider bound to a fresh database, and hands back a repository and
 * `db` for that same database — so a test can assert what was actually written and queued,
 * rather than inferring it from the DOM.
 */
export async function renderWithAndroidApp(
  ui: ReactElement,
  { userId = 'Mom', clock, timeZone, seed }: RenderWithAndroidAppOptions = {},
) {
  const dbName = `AndroidMedGuardTest-${(databaseCounter += 1)}`;

  const db = new AndroidMedGuardDB(dbName);
  const repository = new AndroidRepository(db, {
    clock: clock ?? { nowMs: () => 0, nowIso: () => '1970-01-01T00:00:00.000Z' },
    ids: sequentialIds('seed'),
    userId: 'seed',
    deviceId: 'seed-device',
  });

  if (timeZone) {
    await repository.saveHouseholdSettings({
      id: 'household',
      timeZone,
      escalationAfterMinutes: 15,
      snoozeMinutes: 15,
      updatedAt: '1970-01-01T00:00:00.000Z',
      updatedByDeviceId: 'seed-device',
      syncStatus: 'synced',
    });
  }

  if (seed) {
    await seed(repository);
  }

  const result = render(
    <AndroidAppProvider userId={userId} dbName={dbName} {...(clock ? { clock } : {})}>
      {ui}
    </AndroidAppProvider>,
  );

  return { ...result, db, repository };
}
