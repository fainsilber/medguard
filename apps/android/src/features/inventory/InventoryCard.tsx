import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { daysOfSupply, deriveInventoryState, estimateDailyConsumption } from '@medguard/shared';
import type {
  InventoryAdjustment,
  InventoryItem,
  LocalDate,
  ManualAdjustmentInput,
  Medicine,
  Schedule,
} from '@medguard/shared';
import { useIdGenerator, useRepository } from '../../app/RepositoryContext.js';
import { Badge, Button, Card, colors, styles as sharedStyles } from '../../ui/primitives.js';

/** RN port of `apps/web/src/features/inventory/InventoryCard.tsx`. */

const ADJUSTMENT_REASONS: { value: ManualAdjustmentInput['reason']; label: string; sign: 1 | -1 }[] = [
  { value: 'refill', label: 'Refill (+)', sign: 1 },
  { value: 'lost', label: 'Lost / dropped / spilled (-)', sign: -1 },
  { value: 'correction', label: 'Recount correction (+)', sign: 1 },
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

function SetupForm({ medicine, onDone }: { medicine: Medicine; onDone: () => void }): React.JSX.Element {
  const repository = useRepository();
  const ids = useIdGenerator();
  const [unitName, setUnitName] = useState('pills');
  const [refillThreshold, setRefillThreshold] = useState('');
  const [startingQuantity, setStartingQuantity] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
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
    <View style={formStyles.form}>
      <Text style={sharedStyles.subtitle}>Stock isn't tracked for this medicine yet.</Text>
      <View style={sharedStyles.row}>
        <View style={formStyles.field}>
          <Text style={sharedStyles.label}>Unit</Text>
          <TextInput
            style={sharedStyles.input}
            value={unitName}
            onChangeText={setUnitName}
            accessibilityLabel="Unit"
          />
        </View>
        <View style={formStyles.field}>
          <Text style={sharedStyles.label}>Refill at</Text>
          <TextInput
            style={sharedStyles.input}
            keyboardType="numeric"
            value={refillThreshold}
            onChangeText={setRefillThreshold}
            accessibilityLabel="Refill at"
          />
        </View>
        <View style={formStyles.field}>
          <Text style={sharedStyles.label}>Starting count</Text>
          <TextInput
            style={sharedStyles.input}
            keyboardType="numeric"
            value={startingQuantity}
            onChangeText={setStartingQuantity}
            accessibilityLabel="Starting count"
          />
        </View>
      </View>
      {error && (
        <Text style={sharedStyles.errorText} accessibilityRole="alert">
          {error}
        </Text>
      )}
      <Button
        label={saving ? 'Saving…' : 'Start tracking stock'}
        variant="primary"
        disabled={saving}
        onPress={() => void handleSubmit()}
      />
    </View>
  );
}

function AdjustForm({ medicineId, onDone }: { medicineId: string; onDone: () => void }): React.JSX.Element {
  const repository = useRepository();
  const [reason, setReason] = useState<ManualAdjustmentInput['reason']>('refill');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setError(null);

    const magnitude = Number(amount);
    if (!(magnitude > 0)) {
      setError('Enter an amount greater than zero.');
      return;
    }

    const sign = ADJUSTMENT_REASONS.find((option) => option.value === reason)?.sign ?? 1;

    setSaving(true);
    try {
      await repository.adjustInventory({
        medicineId,
        delta: magnitude * sign,
        reason,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={formStyles.bordered}>
      <Text style={sharedStyles.label}>Reason</Text>
      <View style={formStyles.chipRow}>
        {ADJUSTMENT_REASONS.map((option) => {
          const selected = option.value === reason;
          return (
            <Pressable
              key={option.value}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => setReason(option.value)}
              style={[formStyles.chip, selected ? formStyles.chipSelected : null]}
            >
              <Text style={[formStyles.chipLabel, selected ? formStyles.chipLabelSelected : null]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={sharedStyles.label}>Amount</Text>
      <TextInput
        style={sharedStyles.input}
        keyboardType="numeric"
        value={amount}
        onChangeText={setAmount}
        accessibilityLabel="Amount"
        autoFocus
      />
      <Text style={sharedStyles.label}>Note (optional)</Text>
      <TextInput style={sharedStyles.input} value={note} onChangeText={setNote} accessibilityLabel="Note (optional)" />
      {error && (
        <Text style={sharedStyles.errorText} accessibilityRole="alert">
          {error}
        </Text>
      )}
      <View style={sharedStyles.row}>
        <Button label={saving ? 'Saving…' : 'Save'} variant="primary" disabled={saving} onPress={() => void handleSubmit()} />
        <Button label="Cancel" disabled={saving} onPress={onDone} />
      </View>
    </View>
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
}): React.JSX.Element {
  const [adjusting, setAdjusting] = useState(false);
  const [settingUp, setSettingUp] = useState(false);

  if (!item) {
    return (
      <Card>
        <Text style={formStyles.title}>
          {medicine.name} <Text style={formStyles.strength}>{medicine.strength}</Text>
        </Text>
        {settingUp ? (
          <SetupForm medicine={medicine} onDone={() => setSettingUp(false)} />
        ) : (
          <Button label="Track stock" onPress={() => setSettingUp(true)} />
        )}
      </Card>
    );
  }

  const state = deriveInventoryState(item, adjustments);
  const consumption = estimateDailyConsumption(schedules, medicine.id, today);
  const projection = daysOfSupply(state.currentQuantity, consumption);

  const borderColor = state.isNegative ? colors.locked : state.isLow ? colors.capped : undefined;

  return (
    <Card style={borderColor ? { borderLeftWidth: 4, borderLeftColor: borderColor } : undefined}>
      <View style={formStyles.headerRow}>
        <Text style={formStyles.title}>
          {medicine.name} <Text style={formStyles.strength}>{medicine.strength}</Text>
        </Text>
        {state.isNegative && <Badge tone="locked">Stock count is negative — recount needed</Badge>}
        {!state.isNegative && state.isLow && <Badge tone="capped">Low stock</Badge>}
      </View>

      <Text style={formStyles.quantity}>
        {state.currentQuantity} {state.unitName} remaining
      </Text>
      <Text style={sharedStyles.subtitle}>{formatDaysOfSupply(projection)}</Text>

      {adjusting ? (
        <AdjustForm medicineId={medicine.id} onDone={() => setAdjusting(false)} />
      ) : (
        <Button label="Adjust stock" onPress={() => setAdjusting(true)} />
      )}
    </Card>
  );
}

const formStyles = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  title: { fontSize: 16, fontWeight: '600', color: colors.text },
  strength: { fontWeight: '400', color: colors.textMuted },
  quantity: { fontSize: 14, color: colors.text },
  form: { gap: 8 },
  field: { flex: 1 },
  bordered: {
    gap: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 10,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
  },
  chipSelected: { borderColor: colors.primary, backgroundColor: 'rgba(56, 189, 248, 0.15)' },
  chipLabel: { fontSize: 12, color: colors.textMuted },
  chipLabelSelected: { color: colors.primary, fontWeight: '600' },
});
