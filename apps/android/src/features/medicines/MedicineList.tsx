import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { Medicine, MedicinePatient, Schedule } from '@medguard/shared';
import { usePatients } from '../../app/PatientProvider.js';
import { useRepository } from '../../app/RepositoryContext.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import { Badge, Button, colors, styles as sharedStyles } from '../../ui/primitives.js';
import { ScheduleList } from '../schedules/ScheduleList.js';

/**
 * The RN port of `apps/web/src/features/medicines/MedicineList.tsx`. Medicines are archived,
 * never deleted (safety invariant 1's spirit extended to the medicine record itself) — intake
 * logs reference them forever, and deleting one would orphan a patient's dosing history.
 *
 * Deliberately does not swap in-place to `MedicineForm`/`ScheduleForm` the way web does: a real
 * navigator (React Navigation native-stack) is being wired in separately, so `onAddMedicine`/
 * `onEditMedicine`/`onAddSchedule`/`onEditSchedule` are the seam a stack `Screen` pushes through —
 * a thin adapter, not a rewrite. The nested `ScheduleList` per expanded medicine is otherwise
 * unchanged from web (it stays inline, not pushed) — only its own "Change"/"+ Add schedule"
 * actions go through the navigator.
 */
export function MedicineList({
  onAddMedicine,
  onEditMedicine,
  onAddSchedule,
  onEditSchedule,
}: {
  onAddMedicine: () => void;
  onEditMedicine: (medicine: Medicine) => void;
  onAddSchedule: (medicineId: string, patientId: string) => void;
  onEditSchedule: (schedule: Schedule) => void;
}): React.JSX.Element {
  const repository = useRepository();
  const { filterPatientId } = usePatients();
  const [showArchived, setShowArchived] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Fetched unfiltered for the same reason `TodayView`/`InventoryScreen` are: `useLiveQuery` only
  // re-runs on a table write, not when `filterPatientId` changes, so the patient filter is applied
  // below in a plain `useMemo` instead.
  const allMedicines = useLiveQuery(
    () => (showArchived ? repository.allMedicines() : repository.activeMedicines()),
    ['medicines'],
  );
  const assignments = useLiveQuery<MedicinePatient[]>(
    () => repository.allMedicinePatients(),
    ['medicinePatients'],
  );

  const medicines = useMemo(() => {
    if (allMedicines === undefined) return undefined;
    if (filterPatientId === undefined || assignments === undefined) return allMedicines;
    const assignedIds = new Set(
      assignments
        .filter((assignment) => assignment.active && assignment.patientId === filterPatientId)
        .map((assignment) => assignment.medicineId),
    );
    return allMedicines.filter((medicine) => assignedIds.has(medicine.id));
  }, [allMedicines, assignments, filterPatientId]);

  return (
    <ScrollView style={sharedStyles.screen} contentContainerStyle={{ padding: 16, gap: 16 }}>
      <View style={[sharedStyles.row, { justifyContent: 'space-between' }]}>
        <Text style={sharedStyles.title}>Medicines</Text>
        <Button label="+ Add medicine" onPress={onAddMedicine} variant="primary" />
      </View>

      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: showArchived }}
        onPress={() => setShowArchived((current) => !current)}
        style={sharedStyles.row}
      >
        <Text style={sharedStyles.subtitle}>{showArchived ? '☑' : '☐'} Show archived</Text>
      </Pressable>

      {medicines === undefined ? (
        <Text style={sharedStyles.subtitle}>Loading…</Text>
      ) : medicines.length === 0 ? (
        <Text style={sharedStyles.subtitle}>No medicines yet.</Text>
      ) : (
        <View style={{ gap: 8 }}>
          {medicines.map((medicine) => (
            <View key={medicine.id} style={rowStyle}>
              <View
                style={[
                  sharedStyles.row,
                  { justifyContent: 'space-between', alignItems: 'flex-start' },
                ]}
              >
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={[sharedStyles.row, { flexWrap: 'wrap' }]}>
                    <Text style={{ color: colors.text, fontWeight: '600' }}>
                      {medicine.name}{' '}
                      <Text style={{ color: colors.textMuted }}>{medicine.strength}</Text>
                    </Text>
                    {medicine.asNeeded && <Badge tone="neutral">as needed</Badge>}
                    {medicine.archived && <Badge tone="neutral">archived</Badge>}
                  </View>
                  {(medicine.minHoursBetweenDoses !== undefined ||
                    medicine.maxDailyDoses !== undefined) && (
                    <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                      {medicine.minHoursBetweenDoses !== undefined &&
                        `Min ${medicine.minHoursBetweenDoses}h between doses`}
                      {medicine.minHoursBetweenDoses !== undefined &&
                        medicine.maxDailyDoses !== undefined &&
                        ' · '}
                      {medicine.maxDailyDoses !== undefined && `Max ${medicine.maxDailyDoses}/day`}
                    </Text>
                  )}
                </View>
                <View style={[sharedStyles.row, { flexShrink: 0 }]}>
                  {!medicine.asNeeded && (
                    <Button
                      label={expandedId === medicine.id ? 'Hide schedule' : 'Schedule'}
                      onPress={() =>
                        setExpandedId((current) => (current === medicine.id ? null : medicine.id))
                      }
                    />
                  )}
                  <Button label="Edit" onPress={() => onEditMedicine(medicine)} />
                  {!medicine.archived && (
                    <Button
                      label="Archive"
                      onPress={() => void repository.archiveMedicine(medicine.id)}
                    />
                  )}
                </View>
              </View>

              {/* Nested inside this medicine's own row rather than below the whole list: with a
                  dozen medicines, a panel at the bottom is far from the button that opened it and
                  easy to miss entirely. */}
              {expandedId === medicine.id && (
                <View style={nestedPanelStyle}>
                  <ScheduleList
                    medicineId={medicine.id}
                    onAddSchedule={(patientId) => onAddSchedule(medicine.id, patientId)}
                    onEditSchedule={onEditSchedule}
                  />
                </View>
              )}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const rowStyle = {
  gap: 10,
  borderRadius: 8,
  borderWidth: 1,
  borderColor: colors.border,
  padding: 10,
} as const;

const nestedPanelStyle = {
  borderRadius: 8,
  borderWidth: 1,
  borderColor: colors.border,
  padding: 10,
} as const;
