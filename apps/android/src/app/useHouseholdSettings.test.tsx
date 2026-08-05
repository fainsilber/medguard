import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import { AndroidAppProvider } from './AndroidAppProvider.js';
import { useHouseholdSettings } from './useHouseholdSettings.js';
import { AndroidRepository } from '../db/repository.js';
import { AndroidMedGuardDB } from '../db/schema.js';

const clock = fixedClock('2026-06-15T12:00:00.000Z');

let databaseCounter = 0;

function harness() {
  const dbName = `AndroidHouseholdTest-${(databaseCounter += 1)}`;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AndroidAppProvider userId="Mom" dbName={dbName} clock={clock}>
      {children}
    </AndroidAppProvider>
  );
  return { dbName, wrapper };
}

describe('useHouseholdSettings', () => {
  it('bootstraps a default household on first run so the app is usable with no setup', async () => {
    const { wrapper } = harness();
    const { result } = renderHook(() => useHouseholdSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current).toBeDefined();
    });

    expect(result.current).toMatchObject({
      id: 'household',
      escalationAfterMinutes: 15,
      snoozeMinutes: 15,
    });
    expect(result.current?.timeZone.length).toBeGreaterThan(0);
  });

  it('queues the bootstrapped settings for sync', async () => {
    const { dbName, wrapper } = harness();
    const { result } = renderHook(() => useHouseholdSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current).toBeDefined();
    });

    const repository = new AndroidRepository(new AndroidMedGuardDB(dbName), {
      clock,
      ids: { next: () => 'x' },
      userId: 'probe',
      deviceId: 'probe',
    });
    const [entry] = await repository.pendingSync();
    expect(entry).toMatchObject({ table: 'householdSettings', action: 'CREATE' });
  });

  it('keeps an existing household rather than overwriting it on every mount', async () => {
    const { dbName, wrapper } = harness();
    const seedRepository = new AndroidRepository(new AndroidMedGuardDB(dbName), {
      clock,
      ids: { next: () => 'x' },
      userId: 'seed',
      deviceId: 'seed-device',
    });
    await seedRepository.saveHouseholdSettings({
      id: 'household',
      timeZone: 'America/New_York',
      escalationAfterMinutes: 30,
      snoozeMinutes: 20,
      updatedAt: '',
      updatedByDeviceId: '',
      syncStatus: 'pending',
    });

    const { result } = renderHook(() => useHouseholdSettings(), { wrapper });

    await waitFor(() => {
      expect(result.current?.timeZone).toBe('America/New_York');
    });
    expect(result.current?.escalationAfterMinutes).toBe(30);
  });
});
