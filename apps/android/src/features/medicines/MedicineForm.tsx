import { useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import type { Medicine, MedicineForm as MedicineFormValue } from '@medguard/shared';
import { usePatients } from '../../app/PatientProvider.js';
import { useIdGenerator, useRepository } from '../../app/RepositoryContext.js';
import { useLiveQuery } from '../../store/useLiveQuery.js';
import { Button, KeyboardAvoidingScreen, styles as sharedStyles } from '../../ui/primitives.js';

const MEDICINE_FORMS: readonly MedicineFormValue[] = [
  'pill',
  'liquid',
  'injection',
  'topical',
  'other',
];

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
  const { patients, filterPatientId } = usePatients();

  const existingAssignments = useLiveQuery(
    () => (medicine ? repository.medicinePatientsFor(medicine.id) : Promise.resolve([])),
    ['medicinePatients'],
  );

  const [name, setName] = useState(medicine?.name ?? '');
  const [strength, setStrength] = useState(medicine?.strength ?? '');
  const [form, setForm] = useState<MedicineFormValue>(medicine?.form ?? 'pill');
  const [asNeeded, setAsNeeded] = useState(medicine?.asNeeded ?? false);
  const [minHours, setMinHours] = useState(medicine?.minHoursBetweenDoses?.toString() ?? '');
  const [maxDaily, setMaxDaily] = useState(medicine?.maxDailyDoses?.toString() ?? '');
  const [instructions, setInstructions] = useState(medicine?.instructions ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Who this medicine is assigned to. Seeded once, either from the existing assignment rows (an
  // edit) or from whichever specific patient was selected in the switcher when "Add medicine" was
  // pressed (a sensible default, not a requirement — an empty selection just means "nobody yet").
  const [selectedPatientIds, setSelectedPatientIds] = useState<Set<string>>(new Set());
  const [selectionInitialized, setSelectionInitialized] = useState(false);

  useEffect(() => {
    if (selectionInitialized) return;
    if (medicine) {
      if (existingAssignments === undefined) return;
      setSelectedPatientIds(
        new Set(
          existingAssignments
            .filter((assignment) => assignment.active)
            .map((assignment) => assignment.patientId),
        ),
      );
    } else {
      setSelectedPatientIds(filterPatientId ? new Set([filterPatientId]) : new Set());
    }
    setSelectionInitialized(true);
  }, [medicine, existingAssignments, filterPatientId, selectionInitialized]);

  const togglePatient = (patientId: string) => {
    setSelectedPatientIds((current) => {
      const next = new Set(current);
      if (next.has(patientId)) {
        next.delete(patientId);
      } else {
        next.add(patientId);
      }
      return next;
    });
  };

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
      const medicineId = medicine?.id ?? ids.next();

      await repository.saveMedicine(
        {
          id: medicineId,
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

      const previouslyAssigned = new Set(
        (existingAssignments ?? [])
          .filter((assignment) => assignment.active)
          .map((assignment) => assignment.patientId),
      );
      const toAssign = [...selectedPatientIds].filter((id) => !previouslyAssigned.has(id));
      const toUnassign = [...previouslyAssigned].filter((id) => !selectedPatientIds.has(id));
      await Promise.all([
        ...toAssign.map((patientId) => repository.assignMedicine(medicineId, patientId)),
        ...toUnassign.map((patientId) => repository.unassignMedicine(medicineId, patientId)),
      ]);

      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingScreen>
      <ScrollView contentContainerStyle={sharedStyles.content} keyboardShouldPersistTaps="handled">
        <Text style={sharedStyles.title}>{medicine ? 'Edit medicine' : 'Add medicine'}</Text>

        <View>
          <Text style={sharedStyles.label}>Name</Text>
          <TextInput
            style={sharedStyles.input}
            value={name}
            onChangeText={setName}
            autoFocus
            placeholderTextColor="#64748b"
            // Blank by default with no placeholder text for Maestro to match against, unlike
            // every other field on this form — see docs/testing.md for why this is one of the
            // handful of fields with a testID, used by apps/android/.maestro/offline-smoke.yaml.
            testID="medicine-name-input"
          />
        </View>

        <View>
          <Text style={sharedStyles.label}>Strength</Text>
          <TextInput
            style={sharedStyles.input}
            placeholder="e.g. 50mg"
            placeholderTextColor="#64748b"
            value={strength}
            onChangeText={setStrength}
            testID="medicine-strength-input"
          />
        </View>

        <View>
          <Text style={sharedStyles.label}>Form</Text>
          <View style={[sharedStyles.row, { flexWrap: 'wrap' }]}>
            {MEDICINE_FORMS.map((option) => (
              <Chip
                key={option}
                label={option}
                selected={form === option}
                onPress={() => setForm(option)}
              />
            ))}
          </View>
        </View>

        {patients.length > 0 && (
          <View style={{ gap: 6 }}>
            <Text style={sharedStyles.label}>Who takes this?</Text>
            <Text style={sharedStyles.helpText}>
              Assign to more than one patient to share it — one bottle, one stock count, tracked
              once.
            </Text>
            <View style={[sharedStyles.row, { flexWrap: 'wrap' }]}>
              {patients.map((patient) => (
                <Chip
                  key={patient.id}
                  label={patient.displayName}
                  selected={selectedPatientIds.has(patient.id)}
                  onPress={() => togglePatient(patient.id)}
                />
              ))}
            </View>
          </View>
        )}

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
          <Button
            label={saving ? 'Saving…' : 'Save'}
            onPress={() => void handleSubmit()}
            disabled={saving}
            variant="primary"
          />
          <Button label="Cancel" onPress={onCancel} disabled={saving} />
        </View>
      </ScrollView>
    </KeyboardAvoidingScreen>
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
  return (
    <Button
      label={selected ? `✓ ${label}` : label}
      onPress={onPress}
      variant={selected ? 'primary' : 'default'}
    />
  );
}
