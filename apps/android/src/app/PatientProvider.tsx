import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import * as SecureStore from 'expo-secure-store';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import type { Patient } from '@medguard/shared';
import { useLiveQuery } from '../store/useLiveQuery.js';
import { useRepository } from './RepositoryContext.js';

/**
 * Which patient's data every screen should show: a specific patient, or every patient at once
 * ("All"). Read from `usePatients()`, set from the switcher in the app header. RN port of
 * `apps/web/src/app/PatientProvider.tsx`, backed by `expo-secure-store` instead of `localStorage`
 * — the same substitution `identity/caregiverName.ts` makes, and for the same reason: no
 * synchronous read, so the stored selection loads one tick after mount.
 */
export type PatientSelection = string | 'all';

const STORAGE_KEY = 'medguard-selected-patient-id';

interface PatientContextValue {
  /** Every active (non-archived) patient, ordered for the switcher and the roster screen. Empty
   * only in the instant before the first-run default patient below is created. */
  patients: Patient[];
  selection: PatientSelection;
  select(selection: PatientSelection): void;
  /**
   * `selection` resolved to what the repository's patient-scoped query methods expect —
   * `allMedicines(patientId?)`, `allSchedules(patientId?)`, `allShabbatWindows(patientId?)`,
   * `getShabbatConfig(patientId?)` — the concrete id, or `undefined` for "every patient".
   */
  filterPatientId: string | undefined;
}

const PatientReactContext = createContext<PatientContextValue | null>(null);

/**
 * Must be mounted inside `RepositoryProvider` (i.e. inside `CaregiverGate`/`SyncProvider`), since
 * it reads and writes through `useRepository`.
 */
export function PatientProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const repository = useRepository();

  const allPatients = useLiveQuery(() => repository.allPatients(), ['patients']);
  const patients = useMemo(
    () =>
      (allPatients ?? [])
        .filter((patient) => !patient.archived)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [allPatients],
  );

  const [selection, setSelectionState] = useState<PatientSelection>('all');

  // `expo-secure-store` has no synchronous read, so the stored selection arrives one tick after
  // mount — the screen renders "All" briefly rather than blocking on it, same tradeoff every other
  // secure-store read on this client makes (see `identity/caregiverName.ts`).
  useEffect(() => {
    let cancelled = false;
    void SecureStore.getItemAsync(STORAGE_KEY).then((value) => {
      if (!cancelled && value) {
        setSelectionState(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // First run: a household with medicines but no patient row yet — a fresh local database, or one
  // synced from before multi-patient support reached the server — gets one, named the same way
  // the server's own backfill (migration 0005) names it. A caregiver renames it on first use
  // rather than being forced through "create a patient" just to see medicines they already had.
  useEffect(() => {
    if (allPatients === undefined || allPatients.length > 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const existing = await repository.allPatients();
      if (cancelled || existing.length > 0) {
        return;
      }
      await repository.savePatient(
        {
          id: SINGLE_PATIENT_ID,
          displayName: 'Patient',
          archived: false,
          sortOrder: 0,
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
  }, [allPatients, repository]);

  // A selected patient that no longer exists — archived elsewhere, or never synced to this
  // device — falls back to "All" rather than silently rendering an empty screen with no
  // indication why.
  useEffect(() => {
    if (selection === 'all' || allPatients === undefined) {
      return;
    }
    if (!patients.some((patient) => patient.id === selection)) {
      setSelectionState('all');
    }
  }, [selection, allPatients, patients]);

  const select = (next: PatientSelection) => {
    setSelectionState(next);
    void SecureStore.setItemAsync(STORAGE_KEY, next).catch(() => {
      // Best-effort: a device without secure storage available just re-picks after a restart.
    });
  };

  const value = useMemo<PatientContextValue>(
    () => ({
      patients,
      selection,
      select,
      filterPatientId: selection === 'all' ? undefined : selection,
    }),
    [patients, selection],
  );

  return <PatientReactContext.Provider value={value}>{children}</PatientReactContext.Provider>;
}

export function usePatients(): PatientContextValue {
  const value = useContext(PatientReactContext);
  if (!value) {
    throw new Error('usePatients must be used within a PatientProvider');
  }
  return value;
}
