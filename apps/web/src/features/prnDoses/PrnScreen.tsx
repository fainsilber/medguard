import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import type { ClockTrust, Medicine } from '@medguard/shared';
import { getApiBaseUrl } from '../../api/config.js';
import { usePatients } from '../../app/PatientProvider.js';
import { useClockTrust } from '../../clock/useClockTrust.js';
import { useMedGuardDb } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useTick } from '../../app/useTick.js';
import { Card } from '../../ui/primitives.js';
import { PrnCard } from './PrnCard.js';

/** Countdown re-render tick, shared by every card rather than one interval each — a live 1 hr
 * 14 min-style countdown across five medicines shouldn't cost five timers. */
const COUNTDOWN_TICK_MS = 1000;

interface CardSpec {
  key: string;
  medicine: Medicine;
  patientId: string;
  patientName?: string;
}

/**
 * One card per (medicine, patient) pair, not one per medicine — a medicine shared by several
 * patients needs one independently-scoped safety check per patient (see `assessDose` in
 * `@medguard/shared`'s safety.ts). A medicine with no assignment at all (a transitional state:
 * created before this device's `medicinePatients` rows synced) falls back to the single-patient
 * default rather than silently disappearing from the screen.
 */
function buildCardSpecs(
  medicines: readonly Medicine[],
  assignments: readonly { medicineId: string; patientId: string }[],
  patientNames: ReadonlyMap<string, string>,
  filterPatientId: string | undefined,
  showBadges: boolean,
): CardSpec[] {
  const specs: CardSpec[] = [];
  for (const medicine of medicines) {
    const assignedIds = assignments
      .filter((assignment) => assignment.medicineId === medicine.id)
      .map((assignment) => assignment.patientId);
    const candidateIds = assignedIds.length > 0 ? assignedIds : [SINGLE_PATIENT_ID];
    const idsToShow =
      filterPatientId === undefined
        ? candidateIds
        : candidateIds.filter((id) => id === filterPatientId);

    for (const patientId of idsToShow) {
      specs.push({
        key: `${medicine.id}:${patientId}`,
        medicine,
        patientId,
        ...(showBadges ? { patientName: patientNames.get(patientId) ?? 'Unknown patient' } : {}),
      });
    }
  }
  return specs;
}

/** PRD §2.3's PRN safety screen — one card per as-needed medicine per patient it's assigned to. */
export function PrnScreen({ clockTrust }: { clockTrust?: ClockTrust }) {
  const db = useMedGuardDb();
  const householdSettings = useHouseholdSettings();
  const { patients, filterPatientId } = usePatients();

  // Checked once here for the whole screen rather than per card: it is one shared property of the
  // device, and every card would otherwise poll the server independently.
  const verifiedTrust = useClockTrust(clockTrust ? undefined : getApiBaseUrl());
  const effectiveTrust = clockTrust ?? verifiedTrust;

  useTick(COUNTDOWN_TICK_MS);

  const medicines = useLiveQuery(
    () => db.medicines.filter((medicine) => !medicine.archived && medicine.asNeeded).toArray(),
    [db],
  );
  const logs = useLiveQuery(() => db.intakeLogs.toArray(), [db]);
  const assignments = useLiveQuery(
    () => db.medicinePatients.filter((row) => row.active).toArray(),
    [db],
  );

  const patientNames = useMemo(
    () => new Map(patients.map((patient) => [patient.id, patient.displayName])),
    [patients],
  );
  const showBadges = filterPatientId === undefined && patients.length > 1;

  const cards = useMemo(() => {
    if (!medicines || !assignments) return undefined;
    return buildCardSpecs(medicines, assignments, patientNames, filterPatientId, showBadges);
  }, [medicines, assignments, patientNames, filterPatientId, showBadges]);

  if (!cards || !logs || !householdSettings) {
    return (
      <Card>
        <p className="text-sm text-slate-400">Loading…</p>
      </Card>
    );
  }

  if (cards.length === 0) {
    return (
      <Card>
        <p className="text-sm text-slate-400">No as-needed medicines are set up yet.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {cards.map(({ key, medicine, patientId, patientName }) => (
        <PrnCard
          key={key}
          medicine={medicine}
          patientId={patientId}
          {...(patientName ? { patientName } : {})}
          logs={logs.filter((log) => log.medicineId === medicine.id && log.patientId === patientId)}
          timeZone={householdSettings.timeZone}
          clockTrust={effectiveTrust}
        />
      ))}
    </div>
  );
}
