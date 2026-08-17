import { useMemo } from 'react';
import { ScrollView, Text } from 'react-native';
import { deriveInventoryState, formatLocalDate } from '@medguard/shared';
import type {
  InventoryAdjustment,
  InventoryItem,
  Medicine,
  MedicinePatient,
  Schedule,
} from '@medguard/shared';
import { usePatients } from '../../app/PatientProvider.js';
import { useClock, useRepository } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import {
  Card,
  KeyboardAvoidingScreen,
  colors,
  styles as sharedStyles,
} from '../../ui/primitives.js';
import { InventoryCard } from './InventoryCard.js';

/**
 * RN port of `apps/web/src/features/inventory/InventoryScreen.tsx`. Which medicines appear is
 * filtered by the selected patient (through `medicinePatients`), but stock itself is never split
 * by patient — a shared medicine is one bottle, one ledger, one card, regardless of who's
 * selected.
 */

interface InventoryData {
  allMedicines: Medicine[];
  assignments: MedicinePatient[];
  items: InventoryItem[];
  adjustments: InventoryAdjustment[];
  schedules: Schedule[];
}

export function InventoryScreen(): React.JSX.Element {
  const repository = useRepository();
  const clock = useClock();
  const householdSettings = useHouseholdSettings();
  const { filterPatientId } = usePatients();

  // Fetched unfiltered — `useLiveQuery` only re-runs on a table write, not when `filterPatientId`
  // changes — and filtered by patient below in a plain `useMemo` instead, so switching patients in
  // the header refreshes the screen immediately.
  const data = useLiveQuery<InventoryData>(async () => {
    const allMedicines = await repository.activeMedicines();
    const assignments = await repository.allMedicinePatients();
    const items = await repository.allInventoryItems();
    const schedules = await repository.allSchedules();
    const adjustments = (
      await Promise.all(
        allMedicines.map((medicine) => repository.adjustmentsForMedicine(medicine.id)),
      )
    ).flat();
    return { allMedicines, assignments, items, adjustments, schedules };
  }, ['medicines', 'inventoryItems', 'inventoryAdjustments', 'schedules', 'medicinePatients']);

  const medicines = useMemo(() => {
    if (!data) return undefined;
    if (filterPatientId === undefined) return data.allMedicines;
    const assignedIds = new Set(
      data.assignments
        .filter((assignment) => assignment.active && assignment.patientId === filterPatientId)
        .map((assignment) => assignment.medicineId),
    );
    return data.allMedicines.filter((medicine) => assignedIds.has(medicine.id));
  }, [data, filterPatientId]);

  const today = householdSettings
    ? formatLocalDate(householdSettings.timeZone, clock.nowMs())
    : undefined;

  if (!data || !medicines || !today) {
    return (
      <ScrollView contentContainerStyle={sharedStyles.content} style={sharedStyles.screen}>
        <Card>
          <Text style={sharedStyles.subtitle}>Loading…</Text>
        </Card>
      </ScrollView>
    );
  }

  if (medicines.length === 0) {
    return (
      <ScrollView contentContainerStyle={sharedStyles.content} style={sharedStyles.screen}>
        <Card>
          <Text style={sharedStyles.subtitle}>No medicines yet.</Text>
        </Card>
      </ScrollView>
    );
  }

  const itemsByMedicine = new Map(data.items.map((item) => [item.medicineId, item]));

  const lowStockNames = medicines
    .filter((medicine) => {
      const item = itemsByMedicine.get(medicine.id);
      if (!item) return false;
      return deriveInventoryState(item, data.adjustments).isLow;
    })
    .map((medicine) => medicine.name);

  return (
    <KeyboardAvoidingScreen>
      <ScrollView
        contentContainerStyle={sharedStyles.content}
        style={sharedStyles.screen}
        keyboardShouldPersistTaps="handled"
      >
        {lowStockNames.length > 0 && (
          <Card style={{ borderLeftWidth: 4, borderLeftColor: colors.capped }}>
            <Text style={sharedStyles.label}>Running low: {lowStockNames.join(', ')}</Text>
          </Card>
        )}

        {medicines.map((medicine) => (
          <InventoryCard
            key={medicine.id}
            medicine={medicine}
            item={itemsByMedicine.get(medicine.id)}
            adjustments={data.adjustments.filter(
              (adjustment) => adjustment.medicineId === medicine.id,
            )}
            schedules={data.schedules}
            today={today}
          />
        ))}
      </ScrollView>
    </KeyboardAvoidingScreen>
  );
}
