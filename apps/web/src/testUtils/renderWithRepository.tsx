import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { sequentialIds } from '@medguard/shared/testing';
import type { Clock } from '@medguard/shared';
import { MedGuardRepository } from '@medguard/store';
import { DexieStore } from '@medguard/store/dexie';
import { RepositoryProvider } from '../app/RepositoryContext.js';
import { MedGuardDB } from '../db/schema.js';

/**
 * Test-only infrastructure, not app code — deliberately outside src/db, src/features and
 * src/sync, so the no-ambient-time lint rule doesn't apply here the way it does to the code
 * under test.
 *
 * Each call gets its own uniquely-named database (the same isolation approach
 * `packages/store/src/testing/repositoryConformance.ts` uses), so two renders in the same test
 * file never see each other's data.
 */
let databaseCounter = 0;

export interface RenderWithRepositoryOptions {
  userId?: string;
  /** A fake clock, for anything that needs to drive time deterministically (the PRN screen above all). */
  clock?: Clock;
  /**
   * Pre-seeds household settings with this timezone before mount. Without it, `useHouseholdSettings`
   * bootstraps from the *host machine's* `Intl` timezone, which is a different value on every
   * machine and CI runner — exactly the non-determinism a test suite can't have.
   */
  timeZone?: string;
  /** Runs before mount, given a repository for the same database the component will render against. */
  seed?: (repository: MedGuardRepository) => Promise<void>;
}

export async function renderWithRepository(
  ui: ReactElement,
  { userId = 'Mom', clock, timeZone, seed }: RenderWithRepositoryOptions = {},
) {
  const dbName = `MedGuardTest-${(databaseCounter += 1)}`;

  if (timeZone || seed) {
    const seedDb = new MedGuardDB(dbName);
    const seedRepository = new MedGuardRepository(new DexieStore(seedDb), {
      clock: clock ?? { nowMs: () => 0, nowIso: () => '1970-01-01T00:00:00.000Z' },
      ids: sequentialIds('seed'),
      userId: 'seed',
      deviceId: 'seed-device',
    });

    if (timeZone) {
      await seedRepository.saveHouseholdSettings({
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
      await seed(seedRepository);
    }
  }

  return render(
    <RepositoryProvider userId={userId} dbName={dbName} {...(clock ? { clock } : {})}>
      {ui}
    </RepositoryProvider>,
  );
}
