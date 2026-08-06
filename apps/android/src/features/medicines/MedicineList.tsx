import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { Medicine, Schedule } from '@medguard/shared';
import { useRepository } from '../../app/RepositoryContext.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import { Badge, Button, Card, colors, styles as sharedStyles } from '../../ui/primitives.js';
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
  onAddSchedule: (medicineId: string) => void;
  onEditSchedule: (schedule: Schedule) => void;
}): React.JSX.Element {
  const repository = useRepository();
  const [showArchived, setShowArchived] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const medicines = useLiveQuery(
    () => (showArchived ? repository.allMedicines() : repository.activeMedicines()),
    ['medicines'],
  );

  return (
    <Card>
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
              <View style={[sharedStyles.row, { justifyContent: 'space-between', alignItems: 'flex-start' }]}>
                <View style={{ flex: 1, gap: 4 }}>
                  <View style={[sharedStyles.row, { flexWrap: 'wrap' }]}>
                    <Text style={{ color: colors.text, fontWeight: '600' }}>
                      {medicine.name} <Text style={{ color: colors.textMuted }}>{medicine.strength}</Text>
                    </Text>
                    {medicine.asNeeded && <Badge tone="neutral">as needed</Badge>}
                    {medicine.archived && <Badge tone="neutral">archived</Badge>}
                  </View>
                  {(medicine.minHoursBetweenDoses !== undefined || medicine.maxDailyDoses !== undefined) && (
                    <Text style={{ color: colors.textMuted, fontSize: 12 }}>
                      {medicine.minHoursBetweenDoses !== undefined && `Min ${medicine.minHoursBetweenDoses}h between doses`}
                      {medicine.minHoursBetweenDoses !== undefined && medicine.maxDailyDoses !== undefined && ' · '}
                      {medicine.maxDailyDoses !== undefined && `Max ${medicine.maxDailyDoses}/day`}
                    </Text>
                  )}
                </View>
                <View style={[sharedStyles.row, { flexShrink: 0 }]}>
                  {!medicine.asNeeded && (
                    <Button
                      label={expandedId === medicine.id ? 'Hide schedule' : 'Schedule'}
                      onPress={() => setExpandedId((current) => (current === medicine.id ? null : medicine.id))}
                    />
                  )}
                  <Button label="Edit" onPress={() => onEditMedicine(medicine)} />
                  {!medicine.archived && (
                    <Button label="Archive" onPress={() => void repository.archiveMedicine(medicine.id)} />
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
                    onAddSchedule={() => onAddSchedule(medicine.id)}
                    onEditSchedule={onEditSchedule}
                  />
                </View>
              )}
            </View>
          ))}
        </View>
      )}
    </Card>
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
