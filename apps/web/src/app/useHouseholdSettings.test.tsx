import 'fake-indexeddb/auto';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { RepositoryProvider, useRepository } from './RepositoryContext.js';
import { useHouseholdSettings } from './useHouseholdSettings.js';

afterEach(() => {
  localStorage.clear();
});

function wrapper(dbName: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <RepositoryProvider userId="Mom" dbName={dbName}>
        {children}
      </RepositoryProvider>
    );
  };
}

describe('useHouseholdSettings', () => {
  it('creates a default on first use', async () => {
    const { result } = renderHook(() => useHouseholdSettings(), { wrapper: wrapper('hh-defaults') });

    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current).toMatchObject({ escalationAfterMinutes: 15, snoozeMinutes: 15 });
    expect(typeof result.current?.timeZone).toBe('string');
    expect(result.current?.timeZone.length).toBeGreaterThan(0);
  });

  it('does not overwrite an already-configured household', async () => {
    const dbName = 'hh-existing';
    const { result: repoResult } = renderHook(() => useRepository(), { wrapper: wrapper(dbName) });

    await repoResult.current.saveHouseholdSettings({
      id: 'household',
      timeZone: 'America/New_York',
      escalationAfterMinutes: 30,
      snoozeMinutes: 10,
      updatedAt: '2020-01-01T00:00:00.000Z',
      updatedByDeviceId: 'placeholder',
      syncStatus: 'synced',
    });

    const { result } = renderHook(() => useHouseholdSettings(), { wrapper: wrapper(dbName) });

    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current).toMatchObject({
      timeZone: 'America/New_York',
      escalationAfterMinutes: 30,
      snoozeMinutes: 10,
    });
  });

  it('stays in sync with later writes, via the live query', async () => {
    const dbName = 'hh-live';
    const { result } = renderHook(() => useHouseholdSettings(), { wrapper: wrapper(dbName) });
    await waitFor(() => expect(result.current).toBeDefined());

    const { result: repoResult } = renderHook(() => useRepository(), { wrapper: wrapper(dbName) });
    await repoResult.current.saveHouseholdSettings({
      ...result.current!,
      snoozeMinutes: 20,
    });

    await waitFor(() => expect(result.current?.snoozeMinutes).toBe(20));
  });
});
