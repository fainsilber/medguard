import { useState } from 'react';
import type { FormEvent } from 'react';
import { daysOfSupply, deriveInventoryState, estimateDailyConsumption } from '@medguard/shared';
import type { InventoryAdjustment, InventoryItem, LocalDate, ManualAdjustmentInput, Medicine, Schedule } from '@medguard/shared';
import { useIdGenerator, useRepository } from '../../app/RepositoryContext.js';
import { Badge, Card, buttonClass, inputClass, labelClass, primaryButtonClass } from '../../ui/primitives.js';

const ADJUSTMENT_REASONS: { value: ManualAdjustmentInput['reason']; label: string }[] = [
  { value: 'refill', label: 'Refill (add stock)' },
  { value: 'lost', label: 'Lost / dropped / spilled (remove stock)' },
  { value: 'correction', label: 'Recount (set exact stock)' },
];

function formatDaysOfSupply(days: number | null): string {
  if (days === null) {
    return 'No usage rate yet — set up a schedule to project this.';
  }
  if (days <= 0) {
    return 'Out of supply.';
  }
  const whole = Math.floor(days);
  return whole < 1 ? 'Less than a day of supply left.' : `About ${whole} day${whole === 1 ? '' : 's'} of supply left.`;
}

function SetupForm({ medicine, onDone }: { medicine: Medicine; onDone: () => void }) {
  const repository = useRepository();
  const ids = useIdGenerator();
  const [unitName, setUnitName] = useState('pills');
  const [refillThreshold, setRefillThreshold] = useState('');
  const [startingQuantity, setStartingQuantity] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const trimmedUnit = unitName.trim();
    const threshold = Number(refillThreshold);
    const starting = startingQuantity.trim() === '' ? 0 : Number(startingQuantity);

    if (!trimmedUnit) {
      setError('Unit name is required.');
      return;
    }
    if (!(threshold >= 0)) {
      setError('Refill threshold must be zero or more.');
      return;
    }
    if (!(starting >= 0)) {
      setError('Starting quantity must be zero or more.');
      return;
    }

    setSaving(true);
    try {
      await repository.saveInventoryItem(
        {
          id: ids.next(),
          medicineId: medicine.id,
          refillThreshold: threshold,
          unitName: trimmedUnit,
          updatedAt: '',
          updatedByDeviceId: '',
          syncStatus: 'pending',
        },
        'CREATE',
      );
      if (starting > 0) {
        await repository.adjustInventory({
          medicineId: medicine.id,
          delta: starting,
          reason: 'initial',
        });
      }
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-2 text-sm">
      <p className="text-slate-400">Stock isn&rsquo;t tracked for this medicine yet.</p>
      <div className="grid grid-cols-3 gap-2">
        <label className={labelClass}>
          Unit
          <input className={inputClass} value={unitName} onChange={(e) => setUnitName(e.target.value)} />
        </label>
        <label className={labelClass}>
          Refill at
          <input
            className={inputClass}
            type="number"
            min="0"
            step="0.5"
            value={refillThreshold}
            onChange={(e) => setRefillThreshold(e.target.value)}
          />
        </label>
        <label className={labelClass}>
          Starting count
          <input
            className={inputClass}
            type="number"
            min="0"
            step="0.5"
            value={startingQuantity}
            onChange={(e) => setStartingQuantity(e.target.value)}
          />
        </label>
      </div>
      {error && (
        <p className="text-locked" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className={primaryButtonClass} disabled={saving}>
        {saving ? 'Saving…' : 'Start tracking stock'}
      </button>
    </form>
  );
}

function AdjustForm({
  medicineId,
  currentQuantity,
  onDone,
}: {
  medicineId: string;
  currentQuantity: number;
  onDone: () => void;
}) {
  const repository = useRepository();
  const [reason, setReason] = useState<ManualAdjustmentInput['reason']>('refill');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const magnitude = Number(amount);
    if (!(magnitude > 0)) {
      setError('Enter an amount greater than zero.');
      return;
    }

    // 'refill' adds, 'lost' subtracts, 'correction' (recount) sets the stock to exactly the
    // entered amount rather than adding it — the ledger only stores deltas, so that means the
    // delta between the entered count and what the ledger currently sums to.
    const delta =
      reason === 'refill' ? magnitude : reason === 'lost' ? -magnitude : magnitude - currentQuantity;

    setSaving(true);
    try {
      await repository.adjustInventory({
        medicineId,
        delta,
        reason,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-2 rounded-md border border-slate-700 p-2 text-sm">
      <label className={labelClass}>
        Reason
        <select
          className={inputClass}
          value={reason}
          onChange={(e) => setReason(e.target.value as ManualAdjustmentInput['reason'])}
        >
          {ADJUSTMENT_REASONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        Amount
        <input
          className={inputClass}
          type="number"
          min="0"
          step="0.5"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
        />
      </label>
      <label className={labelClass}>
        Note (optional)
        <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {error && (
        <p className="text-locked" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" className={primaryButtonClass} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className={buttonClass} onClick={onDone} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function InventoryCard({
  medicine,
  item,
  adjustments,
  schedules,
  today,
}: {
  medicine: Medicine;
  item: InventoryItem | undefined;
  adjustments: readonly InventoryAdjustment[];
  schedules: readonly Schedule[];
  today: LocalDate;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const [settingUp, setSettingUp] = useState(false);

  if (!item) {
    return (
      <Card>
        <h3 className="font-medium">
          {medicine.name} <span className="text-slate-400">{medicine.strength}</span>
        </h3>
        {settingUp ? (
          <SetupForm medicine={medicine} onDone={() => setSettingUp(false)} />
        ) : (
          <button type="button" className={buttonClass} onClick={() => setSettingUp(true)}>
            Track stock
          </button>
        )}
      </Card>
    );
  }

  const state = deriveInventoryState(item, adjustments);
  const consumption = estimateDailyConsumption(schedules, medicine.id, today);
  const projection = daysOfSupply(state.currentQuantity, consumption);

  return (
    <Card className={state.isNegative ? 'border-l-4 border-locked' : state.isLow ? 'border-l-4 border-capped' : ''}>
      <div className="flex items-center justify-between">
        <h3 className="font-medium">
          {medicine.name} <span className="text-slate-400">{medicine.strength}</span>
        </h3>
        {state.isNegative && <Badge tone="locked">Stock count is negative — recount needed</Badge>}
        {!state.isNegative && state.isLow && <Badge tone="capped">Low stock</Badge>}
      </div>

      <p className="text-sm">
        {state.currentQuantity} {state.unitName} remaining
      </p>
      <p className="text-xs text-slate-400">{formatDaysOfSupply(projection)}</p>

      {adjusting ? (
        <AdjustForm
          medicineId={medicine.id}
          currentQuantity={state.currentQuantity}
          onDone={() => setAdjusting(false)}
        />
      ) : (
        <button type="button" className={buttonClass} onClick={() => setAdjusting(true)}>
          Adjust stock
        </button>
      )}
    </Card>
  );
}
