import 'fake-indexeddb/auto';
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RepositoryProvider, useMedGuardDb, useRepository } from './RepositoryContext.js';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

function wrapper(userId: string) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <RepositoryProvider userId={userId}>{children}</RepositoryProvider>;
  };
}

describe('useRepository / useMedGuardDb', () => {
  it('throws when used outside a provider, rather than silently returning nothing', () => {
    expect(() => renderHook(() => useRepository())).toThrow(/within a RepositoryProvider/);
    expect(() => renderHook(() => useMedGuardDb())).toThrow(/within a RepositoryProvider/);
  });

  it('provides a working repository', async () => {
    const { result } = renderHook(() => useRepository(), { wrapper: wrapper('Mom') });

    await result.current.saveMedicine({
      id: 'medicine-1',
      patientId: 'patient-1',
      name: 'Ondansetron',
      strength: '4mg',
      form: 'pill',
      archived: false,
      updatedAt: '2020-01-01T00:00:00.000Z',
      updatedByDeviceId: 'irrelevant',
      syncStatus: 'synced',
    });

    expect(await result.current.getMedicine('medicine-1')).toMatchObject({ name: 'Ondansetron' });
  });

  it('attributes writes to the caregiver name passed to the provider', async () => {
    const { result } = renderHook(() => useRepository(), { wrapper: wrapper('Dad') });

    const { log } = await result.current.recordDose({
      id: 'log-1',
      patientId: 'patient-1',
      medicineId: 'medicine-1',
      type: 'prn',
      status: 'taken',
      actualTime: '2020-01-01T00:00:00.000Z',
      quantityTaken: 1,
      loggedByUserId: 'Dad',
      loggedByDeviceId: 'placeholder',
      syncStatus: 'pending',
    });

    expect(log.loggedByUserId).toBe('Dad');
  });

  it('gives useMedGuardDb and useRepository the same underlying database within one provider', async () => {
    const { result } = renderHook(
      () => ({ repository: useRepository(), db: useMedGuardDb() }),
      { wrapper: wrapper('Mom') },
    );

    await result.current.repository.saveMedicine({
      id: 'medicine-2',
      patientId: 'patient-1',
      name: 'Test',
      strength: '1mg',
      form: 'pill',
      archived: false,
      updatedAt: '2020-01-01T00:00:00.000Z',
      updatedByDeviceId: 'irrelevant',
      syncStatus: 'synced',
    });

    // A write through the repository must be visible to a direct db read — proves both hooks
    // resolve to the same MedGuardDB instance rather than two independent databases.
    await expect(result.current.db.medicines.get('medicine-2')).resolves.toMatchObject({
      name: 'Test',
    });
  });
});
