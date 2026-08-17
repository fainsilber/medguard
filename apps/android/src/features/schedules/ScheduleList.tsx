import { useState } from 'react';
import { Text, View } from 'react-native';
import { SINGLE_PATIENT_ID, describeSchedule, formatLocalDate } from '@medguard/shared';
import type { Schedule } from '@medguard/shared';
import { usePatients } from '../../app/PatientProvider.js';
import { useClock, useRepository } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import { Badge, Button, colors, styles as sharedStyles } from '../../ui/primitives.js';

/**
 * A medicine's schedule history: the live version plus every closed one, since a closed
 * schedule still owns the historical doses it produced (safety invariant 1) and stays visible
 * rather than disappearing. RN port of `apps/web/src/features/schedules/ScheduleList.tsx`.
 *
 * A medicine shared by more than one patient has one schedule *per patient* (never one schedule
 * covering both) — so a shared medicine's history here is really two interleaved histories, told
 * apart by a name badge on each row. Unlike web, "Change"/"+ Add schedule" don't swap in
 * `ScheduleForm` in place — they call `onAddSchedule`/`onEditSchedule` so a stack navigator can
 * push `ScheduleForm` as its own screen; for a shared medicine, "+ Add schedule" first shows an
 * inline "for which patient?" picker here (a navigator param, not a separate screen) before
 * calling `onAddSchedule` with the chosen id.
 */
export function ScheduleList({
  medicineId,
  onAddSchedule,
  onEditSchedule,
}: {
  medicineId: string;
  onAddSchedule: (patientId: string) => void;
  onEditSchedule: (schedule: Schedule) => void;
}): React.JSX.Element {
  const repository = useRepository();
  const clock = useClock();
  const householdSettings = useHouseholdSettings();
  const { patients } = usePatients();
  const [choosingPatient, setChoosingPatient] = useState(false);

  const schedules = useLiveQuery(() => repository.schedulesForMedicine(medicineId), ['schedules']);
  const assignedPatientIds = useLiveQuery(async () => {
    const rows = await repository.medicinePatientsFor(medicineId);
    return rows.filter((row) => row.active).map((row) => row.patientId);
  }, ['medicinePatients']);

  const assignedPatients = (assignedPatientIds ?? [])
    .map((id) => patients.find((patient) => patient.id === id))
    .filter((patient): patient is (typeof patients)[number] => patient !== undefined)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const patientNames = new Map(patients.map((patient) => [patient.id, patient.displayName]));
  const isShared = assignedPatients.length > 1;

  const today = householdSettings
    ? formatLocalDate(householdSettings.timeZone, clock.nowMs())
    : undefined;

  const startAdd = () => {
    if (isShared) {
      setChoosingPatient(true);
      return;
    }
    onAddSchedule(assignedPatients[0]?.id ?? SINGLE_PATIENT_ID);
  };

  const active = (schedules ?? []).filter((schedule) => schedule.active);
  const past = (schedules ?? []).filter((schedule) => !schedule.active);
  const [showPast, setShowPast] = useState(false);

  return (
    <View style={{ gap: 10 }}>
      <View style={[sharedStyles.row, { justifyContent: 'space-between' }]}>
        <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>Schedule</Text>
        <Button label="+ Add schedule" onPress={startAdd} disabled={!today} />
      </View>

      {choosingPatient && (
        <View style={{ gap: 6 }}>
          <Text style={sharedStyles.label}>For which patient?</Text>
          <View style={[sharedStyles.row, { flexWrap: 'wrap' }]}>
            {assignedPatients.map((patient) => (
              <Button
                key={patient.id}
                label={patient.displayName}
                onPress={() => {
                  setChoosingPatient(false);
                  onAddSchedule(patient.id);
                }}
              />
            ))}
            <Button label="Cancel" onPress={() => setChoosingPatient(false)} />
          </View>
        </View>
      )}

      {schedules === undefined || !today ? (
        <Text style={sharedStyles.subtitle}>Loading…</Text>
      ) : active.length === 0 ? (
        <Text style={sharedStyles.subtitle}>No active schedule.</Text>
      ) : (
        <View style={{ gap: 6 }}>
          {active.map((schedule) => (
            <View
              key={schedule.id}
              style={[
                sharedStyles.row,
                {
                  justifyContent: 'space-between',
                  borderWidth: 1,
                  borderColor: colors.border,
                  borderRadius: 8,
                  padding: 8,
                },
              ]}
            >
              <View style={{ flex: 1, gap: 4 }}>
                {isShared && (
                  <Badge tone="neutral">
                    {patientNames.get(schedule.patientId) ?? 'Unknown patient'}
                  </Badge>
                )}
                <Text style={{ color: colors.text, fontSize: 13 }}>
                  {describeSchedule(schedule)}
                </Text>
              </View>
              <View style={sharedStyles.row}>
                <Button label="Change" onPress={() => onEditSchedule(schedule)} />
                <Button
                  label="Stop"
                  onPress={() => void repository.closeSchedule(schedule.id, today)}
                />
              </View>
            </View>
          ))}
        </View>
      )}

      {past.length > 0 && (
        <View style={{ gap: 4 }}>
          <Button
            label={
              showPast ? `Hide past schedules (${past.length})` : `Past schedules (${past.length})`
            }
            onPress={() => setShowPast((current) => !current)}
          />
          {showPast && (
            <View style={{ gap: 4 }}>
              {past.map((schedule) => (
                <Text key={schedule.id} style={sharedStyles.subtitle}>
                  {isShared
                    ? `${patientNames.get(schedule.patientId) ?? 'Unknown patient'} — `
                    : ''}
                  {describeSchedule(schedule)} — ended {schedule.endDate ?? '(never took effect)'}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}
