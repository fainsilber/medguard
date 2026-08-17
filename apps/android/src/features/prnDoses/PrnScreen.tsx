import { useEffect, useMemo } from 'react';
import { ScrollView, Text } from 'react-native';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import type { ClockTrust, IntakeLog, Medicine, MedicinePatient } from '@medguard/shared';
import { usePatients } from '../../app/PatientProvider.js';
import { useRepository } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useTick } from '../../app/useTick.js';
import { startLocalClockGuard } from '../../clock/localClockGuard.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import { Card, KeyboardAvoidingScreen, styles as sharedStyles } from '../../ui/primitives.js';
import { PrnCard } from './PrnCard.js';

/** RN port of `apps/web/src/features/prnDoses/PrnScreen.tsx` — PRD §2.3's PRN safety screen, one
 * card per as-needed medicine per patient it's assigned to. */

/** Countdown re-render tick, shared by every card rather than one interval each. */
const COUNTDOWN_TICK_MS = 1000;

interface PrnData {
  medicines: Medicine[];
  logs: IntakeLog[];
  assignments: MedicinePatient[];
}

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
  assignments: readonly { medicineId: string; patientId: string; active: boolean }[],
  patientNames: ReadonlyMap<string, string>,
  filterPatientId: string | undefined,
  showBadges: boolean,
): CardSpec[] {
  const specs: CardSpec[] = [];
  for (const medicine of medicines) {
    const assignedIds = assignments
      .filter((assignment) => assignment.medicineId === medicine.id && assignment.active)
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

export function PrnScreen({ clockTrust }: { clockTrust?: ClockTrust }): React.JSX.Element {
  const repository = useRepository();
  const householdSettings = useHouseholdSettings();
  const { patients, filterPatientId } = usePatients();

  // No server-verified clock trust hook exists yet on Android (that depends on API wiring not
  // built as of this sprint) — `clockTrust` is either injected by a caller (tests, and future
  // wiring once the server check lands) or left undefined, in which case each `PrnCard` falls
  // back to the local guard itself. See `apps/android/src/clock/localClockGuard.ts`.
  //
  // The guard's background refresh loop is started here, not at the module's own load time: it
  // needs `AppState` and a live interval, both real resource use that should track this screen's
  // lifetime rather than run for the whole app session regardless of whether PRN is ever opened.
  useEffect(() => (clockTrust ? undefined : startLocalClockGuard()), [clockTrust]);

  useTick(COUNTDOWN_TICK_MS);

  const data = useLiveQuery<PrnData>(async () => {
    const medicines = (await repository.activeMedicines()).filter((medicine) => medicine.asNeeded);
    const logs = await repository.allLogs();
    const assignments = await repository.allMedicinePatients();
    return { medicines, logs, assignments };
  }, ['medicines', 'intakeLogs', 'medicinePatients']);

  const patientNames = useMemo(
    () => new Map(patients.map((patient) => [patient.id, patient.displayName])),
    [patients],
  );
  const showBadges = filterPatientId === undefined && patients.length > 1;

  const cards = useMemo(() => {
    if (!data) return undefined;
    return buildCardSpecs(
      data.medicines,
      data.assignments,
      patientNames,
      filterPatientId,
      showBadges,
    );
  }, [data, patientNames, filterPatientId, showBadges]);

  if (!cards || !data || !householdSettings) {
    return (
      <ScrollView contentContainerStyle={sharedStyles.content} style={sharedStyles.screen}>
        <Card>
          <Text style={sharedStyles.subtitle}>Loading…</Text>
        </Card>
      </ScrollView>
    );
  }

  if (cards.length === 0) {
    return (
      <ScrollView contentContainerStyle={sharedStyles.content} style={sharedStyles.screen}>
        <Card>
          <Text style={sharedStyles.subtitle}>No as-needed medicines are set up yet.</Text>
        </Card>
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingScreen>
      <ScrollView
        contentContainerStyle={sharedStyles.content}
        style={sharedStyles.screen}
        keyboardShouldPersistTaps="handled"
      >
        {cards.map(({ key, medicine, patientId, patientName }) => (
          <PrnCard
            key={key}
            medicine={medicine}
            patientId={patientId}
            {...(patientName ? { patientName } : {})}
            logs={data.logs.filter(
              (log) => log.medicineId === medicine.id && log.patientId === patientId,
            )}
            timeZone={householdSettings.timeZone}
            {...(clockTrust ? { clockTrust } : {})}
          />
        ))}
      </ScrollView>
    </KeyboardAvoidingScreen>
  );
}
