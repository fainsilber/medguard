import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import type { Medicine, MedicineForm as MedicineFormValue } from '@medguard/shared';
import { useIdGenerator, useRepository } from '../../app/RepositoryContext.js';
import { Button, styles as sharedStyles } from '../../ui/primitives.js';

const MEDICINE_FORMS: readonly MedicineFormValue[] = ['pill', 'liquid', 'injection', 'topical', 'other'];

/**
 * Add or edit a medicine — the RN port of `apps/web/src/features/medicines/MedicineForm.tsx`.
 * Editing writes the same id back (an in-place field correction, not a new version) — unlike
 * schedules, a medicine's name or as-needed guard isn't something that needs a historical trail
 * the way a dose amount does.
 *
 * Pushed onto a stack by the caller (see `MedicineList`'s callback props) rather than swapped in
 * place — `medicine` present means "edit", absent means "add", exactly like web's optional prop.
 */
export function MedicineForm({
  medicine,
  onDone,
  onCancel,
}: {
  medicine?: Medicine;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const repository = useRepository();
  const ids = useIdGenerator();

  const [name, setName] = useState(medicine?.name ?? '');
  const [strength, setStrength] = useState(medicine?.strength ?? '');
  const [form, setForm] = useState<MedicineFormValue>(medicine?.form ?? 'pill');
  const [asNeeded, setAsNeeded] = useState(medicine?.asNeeded ?? false);
  const [minHours, setMinHours] = useState(medicine?.minHoursBetweenDoses?.toString() ?? '');
  const [maxDaily, setMaxDaily] = useState(medicine?.maxDailyDoses?.toString() ?? '');
  const [instructions, setInstructions] = useState(medicine?.instructions ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    setError(null);

    const trimmedName = name.trim();
    const trimmedStrength = strength.trim();
    if (!trimmedName || !trimmedStrength) {
      setError('Name and strength are required.');
      return;
    }

    const minHoursValue = !asNeeded || minHours.trim() === '' ? undefined : Number(minHours);
    if (minHoursValue !== undefined && !(minHoursValue > 0)) {
      setError('Minimum hours between doses must be a positive number.');
      return;
    }

    const maxDailyValue = !asNeeded || maxDaily.trim() === '' ? undefined : Number(maxDaily);
    if (maxDailyValue !== undefined && !(Number.isInteger(maxDailyValue) && maxDailyValue > 0)) {
      setError('Max doses per day must be a positive whole number.');
      return;
    }

    setSaving(true);
    try {
      await repository.saveMedicine(
        {
          id: medicine?.id ?? ids.next(),
          patientId: medicine?.patientId ?? SINGLE_PATIENT_ID,
          name: trimmedName,
          strength: trimmedStrength,
          form,
          asNeeded,
          archived: medicine?.archived ?? false,
          ...(minHoursValue !== undefined ? { minHoursBetweenDoses: minHoursValue } : {}),
          ...(maxDailyValue !== undefined ? { maxDailyDoses: maxDailyValue } : {}),
          ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
          // Overwritten by the repository's own stamp on every save; placeholders here just
          // satisfy the type before that happens.
          updatedAt: medicine?.updatedAt ?? '',
          updatedByDeviceId: medicine?.updatedByDeviceId ?? '',
          syncStatus: medicine?.syncStatus ?? 'pending',
        },
        medicine ? 'UPDATE' : 'CREATE',
      );
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={sharedStyles.content}>
      <Text style={sharedStyles.title}>{medicine ? 'Edit medicine' : 'Add medicine'}</Text>

      <View>
        <Text style={sharedStyles.label}>Name</Text>
        <TextInput style={sharedStyles.input} value={name} onChangeText={setName} autoFocus placeholderTextColor="#64748b" />
      </View>

      <View>
        <Text style={sharedStyles.label}>Strength</Text>
        <TextInput
          style={sharedStyles.input}
          placeholder="e.g. 50mg"
          placeholderTextColor="#64748b"
          value={strength}
          onChangeText={setStrength}
        />
      </View>

      <View>
        <Text style={sharedStyles.label}>Form</Text>
        <View style={[sharedStyles.row, { flexWrap: 'wrap' }]}>
          {MEDICINE_FORMS.map((option) => (
            <Chip key={option} label={option} selected={form === option} onPress={() => setForm(option)} />
          ))}
        </View>
      </View>

      <View style={{ gap: 6 }}>
        <Text style={sharedStyles.label}>How is it taken?</Text>
        <Chip
          label="On a schedule (set on the medicine's own page after saving)"
          selected={!asNeeded}
          onPress={() => setAsNeeded(false)}
        />
        <Chip
          label="As needed — no fixed times, given when it's needed"
          selected={asNeeded}
          onPress={() => setAsNeeded(true)}
        />
      </View>

      {asNeeded && (
        <View style={[sharedStyles.row, { justifyContent: 'space-between' }]}>
          <View style={{ flex: 1 }}>
            <Text style={sharedStyles.label}>Min hours between doses</Text>
            <TextInput
              style={sharedStyles.input}
              keyboardType="numeric"
              placeholder="optional"
              placeholderTextColor="#64748b"
              value={minHours}
              onChangeText={setMinHours}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={sharedStyles.label}>Max doses / day</Text>
            <TextInput
              style={sharedStyles.input}
              keyboardType="numeric"
              placeholder="optional"
              placeholderTextColor="#64748b"
              value={maxDaily}
              onChangeText={setMaxDaily}
            />
          </View>
        </View>
      )}

      <View>
        <Text style={sharedStyles.label}>Instructions</Text>
        <TextInput
          style={sharedStyles.input}
          multiline
          numberOfLines={2}
          placeholder="e.g. Take on an empty stomach"
          placeholderTextColor="#64748b"
          value={instructions}
          onChangeText={setInstructions}
        />
      </View>

      {error && (
        <Text style={sharedStyles.errorText} accessibilityRole="alert">
          {error}
        </Text>
      )}

      <View style={sharedStyles.row}>
        <Button label={saving ? 'Saving…' : 'Save'} onPress={() => void handleSubmit()} disabled={saving} variant="primary" />
        <Button label="Cancel" onPress={onCancel} disabled={saving} />
      </View>
    </ScrollView>
  );
}

/**
 * A selectable "chip" button, standing in for web's `<select>`/radio inputs — RN has no native
 * `<select>`, and this app deliberately doesn't add a dropdown library (see task constraints).
 */
function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return <Button label={selected ? `✓ ${label}` : label} onPress={onPress} variant={selected ? 'primary' : 'default'} />;
}
