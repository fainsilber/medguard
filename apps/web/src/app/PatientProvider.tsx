import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import type { Patient } from '@medguard/shared';
import { useMedGuardDb, useRepository } from './RepositoryContext.js';

/**
 * Which patient's data every screen should show: a specific patient, or every patient at once
 * ("All"). Read from `usePatients()`, set from the switcher in the app header.
 */
export type PatientSelection = string | 'all';

const STORAGE_KEY = 'medguard.selectedPatientId';

interface PatientContextValue {
  /** Every active (non-archived) patient, ordered for the switcher and the roster screen. Empty
   * only in the instant before the first-run default patient below is created. */
  patients: Patient[];
  selection: PatientSelection;
  select(selection: PatientSelection): void;
  /**
   * `selection` resolved to what the repository's patient-scoped query methods expect —
   * `allMedicines(patientId?)`, `allSchedules(patientId?)`, `allShabbatWindows(patientId?)`,
   * `getShabbatConfig(patientId?)` — the concrete id, or `undefined` for "every patient", which is
   * exactly what those methods treat as "no filter" today.
   */
  filterPatientId: string | undefined;
}

const PatientReactContext = createContext<PatientContextValue | null>(null);

function readStoredSelection(): PatientSelection {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? 'all';
  } catch {
    // Private browsing, or storage disabled — falls back to "All" every load rather than throwing.
    return 'all';
  }
}

function writeStoredSelection(selection: PatientSelection): void {
  try {
    localStorage.setItem(STORAGE_KEY, selection);
  } catch {
    // Best-effort: a caregiver without persistent storage just re-picks after a reload.
  }
}

/**
 * Owns the patient roster and which one (or "all") is currently selected, mirroring
 * `RepositoryContext`'s pattern of a live Dexie query plus a first-run bootstrap — see
 * `useHouseholdSettings.ts` for the same shape applied to household settings.
 *
 * Must be mounted inside `RepositoryProvider` (i.e. inside `CaregiverGate`), since it reads and
 * writes through `useMedGuardDb`/`useRepository`.
 */
export function PatientProvider({ children }: { children: ReactNode }) {
  const db = useMedGuardDb();
  const repository = useRepository();

  const allPatients = useLiveQuery(() => db.patients.toArray(), [db]);
  const patients = useMemo(
    () =>
      (allPatients ?? [])
        .filter((patient) => !patient.archived)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [allPatients],
  );

  const [selection, setSelection] = useState<PatientSelection>(readStoredSelection);

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
      const existing = await db.patients.count();
      if (cancelled || existing > 0) {
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
  }, [allPatients, db, repository]);

  // A selected patient that no longer exists — archived elsewhere, or never synced to this
  // device — falls back to "All" rather than silently rendering an empty screen with no
  // indication why.
  useEffect(() => {
    if (selection === 'all' || allPatients === undefined) {
      return;
    }
    if (!patients.some((patient) => patient.id === selection)) {
      setSelection('all');
    }
  }, [selection, allPatients, patients]);

  const select = (next: PatientSelection) => {
    setSelection(next);
    writeStoredSelection(next);
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
