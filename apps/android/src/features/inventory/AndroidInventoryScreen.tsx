import { useState, useEffect } from 'react';
import {
  toIso,
  systemClock,
  uuidIdGenerator,
  type Inventory,
  type Medicine,
} from '@medguard/shared';
import { androidDb } from '../../db/androidDb.js';
import {
  M3Card,
  M3Badge,
  m3ButtonPrimary,
  m3InputClass,
} from '../../ui/MaterialComponents.js';

export function AndroidInventoryScreen({ caregiverName: _caregiverName }: { caregiverName: string }) {
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [inventoryList, setInventoryList] = useState<Inventory[]>([]);
  const [selectedMed, setSelectedMed] = useState<Medicine | null>(null);
  const [refillQuantity, setRefillQuantity] = useState('');

  const loadData = async () => {
    const medList = await androidDb.medicines.toArray();
    const invList = await androidDb.inventory.toArray();
    setMedicines(medList);
    setInventoryList(invList);
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRefillStock = async () => {
    if (!selectedMed || !refillQuantity) return;
    const qty = Number(refillQuantity);
    if (isNaN(qty) || qty <= 0) return;

    const nowIso = toIso(systemClock.now());
    let inv = inventoryList.find((i) => i.medicineId === selectedMed.id);

    if (!inv) {
      inv = {
        id: uuidIdGenerator.generate(),
        medicineId: selectedMed.id,
        currentQuantity: qty,
        refillThreshold: 10,
        unitName: 'pills',
        lastRefilledAt: nowIso,
        updatedAt: nowIso,
        syncStatus: 'pending',
      };
      await androidDb.inventory.add(inv);
    } else {
      inv = {
        ...inv,
        currentQuantity: inv.currentQuantity + qty,
        lastRefilledAt: nowIso,
        updatedAt: nowIso,
        syncStatus: 'pending',
      };
      await androidDb.inventory.put(inv);
    }

    await androidDb.syncOutbox.add({
      table: 'inventory',
      entityId: inv.id,
      action: 'UPDATE',
      payload: inv,
      createdAt: nowIso,
    });

    setSelectedMed(null);
    setRefillQuantity('');
    await loadData();
  };

  return (
    <div className="flex flex-col gap-4 p-4 pb-24">
      <div className="flex flex-col">
        <h2 className="text-xl font-bold tracking-tight text-slate-100">Inventory Ledger</h2>
        <p className="text-xs text-slate-400">
          Append-only inventory tracking with automated refill alerts.
        </p>
      </div>

      {/* Stock Refill Modal */}
      {selectedMed && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-slate-700 bg-slate-900 p-6 shadow-2xl flex flex-col gap-4">
            <h3 className="text-lg font-bold text-slate-100">Refill {selectedMed.name}</h3>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-400">Pills / Units Added:</label>
              <input
                type="number"
                placeholder="e.g., 30"
                className={m3InputClass}
                value={refillQuantity}
                onChange={(e) => setRefillQuantity(e.target.value)}
              />
            </div>

            <button onClick={handleRefillStock} className={m3ButtonPrimary}>
              Log Refill Adjustment
            </button>

            <button
              onClick={() => {
                setSelectedMed(null);
                setRefillQuantity('');
              }}
              className="text-xs font-semibold text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Inventory List */}
      {medicines.length === 0 ? (
        <M3Card>
          <p className="text-sm text-slate-400 text-center py-4">No medicines in inventory.</p>
        </M3Card>
      ) : (
        medicines.map((med) => {
          const inv = inventoryList.find((i) => i.medicineId === med.id);
          const currentQty = inv?.currentQuantity ?? 0;
          const isLowStock = currentQty <= (inv?.refillThreshold ?? 10);

          return (
            <M3Card key={med.id}>
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-base font-bold text-slate-100">{med.name}</span>
                  <span className="text-xs text-slate-400">{med.strength}</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-xl font-bold font-mono text-slate-100">
                    {currentQty} {inv?.unitName || 'units'}
                  </span>
                  <M3Badge tone={isLowStock ? 'locked' : 'safe'}>
                    {isLowStock ? 'Low Stock' : 'In Stock'}
                  </M3Badge>
                </div>
              </div>

              <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-800/80">
                <span className="text-xs text-slate-400">
                  Refill alert below {inv?.refillThreshold ?? 10} units
                </span>
                <button
                  onClick={() => setSelectedMed(med)}
                  className={m3ButtonPrimary}
                >
                  Refill Stock
                </button>
              </div>
            </M3Card>
          );
        })
      )}
    </div>
  );
}
