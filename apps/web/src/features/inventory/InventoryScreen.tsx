import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { deriveInventoryState, formatLocalDate } from '@medguard/shared';
import { useClock, useMedGuardDb } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { Card } from '../../ui/primitives.js';
import { InventoryCard } from './InventoryCard.js';

/** PRD's low-stock banner plus per-medicine stock cards, days-of-supply, and manual adjustments. */
export function InventoryScreen() {
  const db = useMedGuardDb();
  const clock = useClock();
  const householdSettings = useHouseholdSettings();

  const medicines = useLiveQuery(
    () => db.medicines.filter((medicine) => !medicine.archived).toArray(),
    [db],
  );
  const items = useLiveQuery(() => db.inventoryItems.toArray(), [db]);
  const adjustments = useLiveQuery(() => db.inventoryAdjustments.toArray(), [db]);
  const schedules = useLiveQuery(() => db.schedules.toArray(), [db]);

  const today = householdSettings ? formatLocalDate(householdSettings.timeZone, clock.nowMs()) : undefined;

  const lowStockNames = useMemo(() => {
    if (!medicines || !items || !adjustments) {
      return undefined;
    }
    const itemsByMedicine = new Map(items.map((item) => [item.medicineId, item]));
    return medicines
      .filter((medicine) => {
        const item = itemsByMedicine.get(medicine.id);
        if (!item) return false;
        return deriveInventoryState(item, adjustments).isLow;
      })
      .map((medicine) => medicine.name);
  }, [medicines, items, adjustments]);

  if (!medicines || !items || !adjustments || !schedules || !today) {
    return (
      <Card>
        <p className="text-sm text-slate-400">Loading…</p>
      </Card>
    );
  }

  if (medicines.length === 0) {
    return (
      <Card>
        <p className="text-sm text-slate-400">No medicines yet.</p>
      </Card>
    );
  }

  const itemsByMedicine = new Map(items.map((item) => [item.medicineId, item]));

  return (
    <div className="flex flex-col gap-3">
      {lowStockNames && lowStockNames.length > 0 && (
        <Card className="border-l-4 border-capped">
          <p className="text-sm font-medium">
            Running low: {lowStockNames.join(', ')}
          </p>
        </Card>
      )}

      {medicines.map((medicine) => (
        <InventoryCard
          key={medicine.id}
          medicine={medicine}
          item={itemsByMedicine.get(medicine.id)}
          adjustments={adjustments.filter((adjustment) => adjustment.medicineId === medicine.id)}
          schedules={schedules}
          today={today}
        />
      ))}
    </div>
  );
}
