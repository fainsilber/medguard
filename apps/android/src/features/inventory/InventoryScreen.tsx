import { ScrollView, Text } from 'react-native';
import { deriveInventoryState, formatLocalDate } from '@medguard/shared';
import type { InventoryAdjustment, InventoryItem, Medicine, Schedule } from '@medguard/shared';
import { useClock, useRepository } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import { Card, colors, styles as sharedStyles } from '../../ui/primitives.js';
import { InventoryCard } from './InventoryCard.js';

/** RN port of `apps/web/src/features/inventory/InventoryScreen.tsx`. */

interface InventoryData {
  medicines: Medicine[];
  items: InventoryItem[];
  adjustments: InventoryAdjustment[];
  schedules: Schedule[];
}

export function InventoryScreen(): React.JSX.Element {
  const repository = useRepository();
  const clock = useClock();
  const householdSettings = useHouseholdSettings();

  const data = useLiveQuery<InventoryData>(async () => {
    const medicines = await repository.activeMedicines();
    const items = await repository.allInventoryItems();
    const schedules = await repository.allSchedules();
    const adjustments = (
      await Promise.all(medicines.map((medicine) => repository.adjustmentsForMedicine(medicine.id)))
    ).flat();
    return { medicines, items, adjustments, schedules };
  }, ['medicines', 'inventoryItems', 'inventoryAdjustments', 'schedules']);

  const today = householdSettings ? formatLocalDate(householdSettings.timeZone, clock.nowMs()) : undefined;

  if (!data || !today) {
    return (
      <ScrollView contentContainerStyle={sharedStyles.content} style={sharedStyles.screen}>
        <Card>
          <Text style={sharedStyles.subtitle}>Loading…</Text>
        </Card>
      </ScrollView>
    );
  }

  if (data.medicines.length === 0) {
    return (
      <ScrollView contentContainerStyle={sharedStyles.content} style={sharedStyles.screen}>
        <Card>
          <Text style={sharedStyles.subtitle}>No medicines yet.</Text>
        </Card>
      </ScrollView>
    );
  }

  const itemsByMedicine = new Map(data.items.map((item) => [item.medicineId, item]));

  const lowStockNames = data.medicines
    .filter((medicine) => {
      const item = itemsByMedicine.get(medicine.id);
      if (!item) return false;
      return deriveInventoryState(item, data.adjustments).isLow;
    })
    .map((medicine) => medicine.name);

  return (
    <ScrollView contentContainerStyle={sharedStyles.content} style={sharedStyles.screen}>
      {lowStockNames.length > 0 && (
        <Card style={{ borderLeftWidth: 4, borderLeftColor: colors.capped }}>
          <Text style={sharedStyles.label}>Running low: {lowStockNames.join(', ')}</Text>
        </Card>
      )}

      {data.medicines.map((medicine) => (
        <InventoryCard
          key={medicine.id}
          medicine={medicine}
          item={itemsByMedicine.get(medicine.id)}
          adjustments={data.adjustments.filter((adjustment) => adjustment.medicineId === medicine.id)}
          schedules={data.schedules}
          today={today}
        />
      ))}
    </ScrollView>
  );
}
