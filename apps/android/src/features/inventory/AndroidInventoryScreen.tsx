import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { deriveInventoryState } from '@medguard/shared';
import type { InventoryItem, Medicine } from '@medguard/shared';
import {
  useCurrentDeviceId,
  useIdGenerator,
  useMedGuardDb,
  useRepository,
} from '../../app/AndroidAppProvider.js';
import { M3Badge, M3Card, m3ButtonPrimary, m3InputClass } from '../../ui/MaterialComponents.js';

const DEFAULT_REFILL_THRESHOLD = 10;
const DEFAULT_UNIT_NAME = 'units';

export function AndroidInventoryScreen() {
  const db = useMedGuardDb();
  const repository = useRepository();
  const ids = useIdGenerator();
  const deviceId = useCurrentDeviceId();

  const [refilling, setRefilling] = useState<Medicine | null>(null);
  const [quantity, setQuantity] = useState('');
  const [error, setError] = useState<string | null>(null);

  const medicines = useLiveQuery(() => db.medicines.toArray(), [db]);
  const items = useLiveQuery(() => db.inventoryItems.toArray(), [db]);
  const adjustments = useLiveQuery(() => db.inventoryAdjustments.toArray(), [db]);

  const itemFor = (medicineId: string) =>
    (items ?? []).find((candidate) => candidate.medicineId === medicineId);

  const refill = async () => {
    if (!refilling) {
      return;
    }
    const delta = Number(quantity);
    if (!Number.isFinite(delta) || delta <= 0) {
      setError('Enter a quantity greater than zero.');
      return;
    }

    // The tracking config is created on first refill if it does not exist yet; the quantity
    // itself never lives on it. Stock is the sum of the ledger, so two caregivers refilling
    // offline both land, instead of one silently overwriting the other under Last-Write-Wins.
    const existing = itemFor(refilling.id);
    const item: InventoryItem = existing ?? {
      id: ids.next(),
      medicineId: refilling.id,
      refillThreshold: DEFAULT_REFILL_THRESHOLD,
      unitName: DEFAULT_UNIT_NAME,
      updatedAt: '',
      updatedByDeviceId: deviceId,
      syncStatus: 'pending',
    };

    await repository.saveInventoryItem(item, existing ? 'UPDATE' : 'CREATE');
    await repository.adjustInventory({
      medicineId: refilling.id,
      delta,
      reason: existing ? 'refill' : 'initial',
    });

    setRefilling(null);
    setQuantity('');
    setError(null);
  };

  return (
    <div className="flex flex-col gap-4 p-4 pb-28">
      <div className="flex flex-col">
        <h2 className="text-xl font-bold tracking-tight text-slate-100">Inventory ledger</h2>
        <p className="text-xs text-slate-400">
          Append-only stock tracking with refill alerts. Every dose logged decrements stock.
        </p>
      </div>

      {refilling && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="flex w-full max-w-sm flex-col gap-4 rounded-3xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-100">Refill {refilling.name}</h3>

            <div className="flex flex-col gap-1">
              <label htmlFor="refill-quantity" className="text-xs font-semibold text-slate-400">
                Units added
              </label>
              <input
                id="refill-quantity"
                type="number"
                placeholder="e.g. 30"
                className={m3InputClass}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </div>

            {error && (
              <p role="alert" className="text-xs font-semibold text-rose-400">
                {error}
              </p>
            )}

            <button onClick={() => void refill()} className={m3ButtonPrimary}>
              Log refill
            </button>

            <button
              onClick={() => {
                setRefilling(null);
                setQuantity('');
                setError(null);
              }}
              className="text-xs font-semibold text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {medicines && medicines.length === 0 ? (
        <M3Card>
          <p className="py-4 text-center text-sm text-slate-400">No medicines to track yet.</p>
        </M3Card>
      ) : (
        (medicines ?? []).map((medicine) => {
          const item = itemFor(medicine.id);
          const state = item ? deriveInventoryState(item, adjustments ?? []) : undefined;

          return (
            <M3Card key={medicine.id}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-base font-bold text-slate-100">{medicine.name}</span>
                  <span className="text-xs text-slate-400">{medicine.strength}</span>
                </div>

                <div className="flex items-center gap-2">
                  <span className="font-mono text-xl font-bold text-slate-100">
                    {state ? `${state.currentQuantity} ${state.unitName}` : 'Not tracked'}
                  </span>
                  {state && (
                    <M3Badge tone={state.isNegative ? 'locked' : state.isLow ? 'capped' : 'safe'}>
                      {/* Negative stock is shown, never clamped: it means doses were logged that
                          the recorded stock could not have covered, which is a real bookkeeping
                          error a caregiver needs to see. */}
                      {state.isNegative ? 'Check count' : state.isLow ? 'Low stock' : 'In stock'}
                    </M3Badge>
                  )}
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between gap-3 border-t border-slate-800/80 pt-2">
                <span className="text-xs text-slate-400">
                  {state
                    ? `Refill alert at or below ${state.refillThreshold} ${state.unitName}`
                    : 'Log a first count to start tracking'}
                </span>
                <button
                  onClick={() => {
                    setRefilling(medicine);
                    setError(null);
                  }}
                  className={m3ButtonPrimary}
                >
                  {state ? 'Refill' : 'Set count'}
                </button>
              </div>
            </M3Card>
          );
        })
      )}
    </div>
  );
}
