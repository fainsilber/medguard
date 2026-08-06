import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { DAY_LABELS, SINGLE_PATIENT_ID } from '@medguard/shared';
import type { FrequencyType, LocalDate, Schedule } from '@medguard/shared';
import { useIdGenerator, useRepository } from '../../app/RepositoryContext.js';
import { Button, styles as sharedStyles } from '../../ui/primitives.js';

const FREQUENCY_OPTIONS: ReadonlyArray<{ value: FrequencyType; label: string }> = [
  { value: 'daily', label: 'Every day' },
  { value: 'interval_days', label: 'Every N days' },
  { value: 'specific_days', label: 'Specific days of the week' },
];

/** `HH:MM`, 24-hour, matching the `LocalTime` shape produced by web's `<input type="time">`. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
/** `YYYY-MM-DD`, matching the `LocalDate` shape produced by web's `<input type="date">`. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

function isValidDate(value: string): boolean {
  return DATE_PATTERN.test(value);
}

/**
 * Create a new schedule, or revise an existing one — the RN port of
 * `apps/web/src/features/schedules/ScheduleForm.tsx`, the most complex form in the app.
 *
 * Revising never edits in place (PRD §2.2 — "modifying a dose updates future scheduled events
 * without mutating historical intake logs"): submitting against an existing schedule closes it
 * and creates a new version effective from the chosen date, via `repository.reviseSchedule`. A
 * brand-new schedule calls `repository.saveSchedule(..., 'CREATE')` instead. The caregiver only
 * ever sees "save"; the versioning happens underneath — get this branch exactly right, it's the
 * core "never rewrite history" invariant of the whole app.
 *
 * No time/date picker library is installed (deliberately — no unverifiable new native module), so
 * `timesOfDay` entries and the date fields are plain text inputs, validated here with a regex and
 * an inline error rather than guaranteed correct by the input widget the way web's
 * `<input type="time">`/`<input type="date">` are.
 */
export function ScheduleForm({
  medicineId,
  existing,
  today,
  onDone,
  onCancel,
}: {
  medicineId: string;
  existing?: Schedule;
  /** The household-local date, for defaulting a revision's effective date to "today". */
  today: LocalDate;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const repository = useRepository();
  const ids = useIdGenerator();

  const [frequencyType, setFrequencyType] = useState<FrequencyType>(existing?.frequencyType ?? 'daily');
  const [intervalDays, setIntervalDays] = useState(existing?.intervalDays?.toString() ?? '2');
  const [daysOfWeek, setDaysOfWeek] = useState<number[]>(existing?.daysOfWeek ?? []);
  const [timesOfDay, setTimesOfDay] = useState<string[]>(
    existing?.timesOfDay && existing.timesOfDay.length > 0 ? existing.timesOfDay : ['08:00'],
  );
  const [dosageQuantity, setDosageQuantity] = useState(existing?.dosageQuantity?.toString() ?? '1');
  const [startDate, setStartDate] = useState(existing?.startDate ?? today);
  const [endDate, setEndDate] = useState(existing?.endDate ?? '');
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const toggleDay = (day: number) => {
    setDaysOfWeek((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort()));
  };

  const updateTime = (index: number, value: string) => {
    setTimesOfDay((current) => current.map((time, i) => (i === index ? value : time)));
  };

  const removeTime = (index: number) => {
    setTimesOfDay((current) => current.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    setError(null);

    const nonEmptyTimes = timesOfDay.filter((time) => time !== '');
    if (nonEmptyTimes.some((time) => !isValidTime(time))) {
      setError('Enter each time of day as HH:MM (e.g. 08:00).');
      return;
    }
    const cleanTimes = [...new Set(nonEmptyTimes)].sort();
    if (cleanTimes.length === 0) {
      setError('At least one time of day is required.');
      return;
    }

    const quantity = Number(dosageQuantity);
    if (!(quantity > 0)) {
      setError('Dose quantity must be a positive number.');
      return;
    }

    if (frequencyType === 'interval_days' && !(Number(intervalDays) >= 1)) {
      setError('Interval must be at least 1 day.');
      return;
    }
    if (frequencyType === 'specific_days' && daysOfWeek.length === 0) {
      setError('Select at least one day of the week.');
      return;
    }

    const dateFieldLabel = existing ? 'Effective date' : 'Start date';
    const dateFieldValue = existing ? effectiveFrom : startDate;
    if (!isValidDate(dateFieldValue)) {
      setError(`${dateFieldLabel} must be in YYYY-MM-DD format.`);
      return;
    }
    if (endDate && !isValidDate(endDate)) {
      setError('End date must be in YYYY-MM-DD format.');
      return;
    }

    if (endDate && endDate < (existing ? effectiveFrom : startDate)) {
      setError('End date cannot be before the start date.');
      return;
    }

    const shared = {
      frequencyType,
      timesOfDay: cleanTimes,
      dosageQuantity: quantity,
      ...(frequencyType === 'interval_days' ? { intervalDays: Number(intervalDays) } : {}),
      ...(frequencyType === 'specific_days' ? { daysOfWeek } : {}),
      ...(endDate ? { endDate } : {}),
    };

    setSaving(true);
    try {
      if (existing) {
        await repository.reviseSchedule(existing.id, shared, effectiveFrom);
      } else {
        await repository.saveSchedule(
          {
            id: ids.next(),
            medicineId,
            patientId: SINGLE_PATIENT_ID,
            startDate,
            active: true,
            ...shared,
            // Overwritten by the repository's own stamp; placeholders satisfy the type.
            updatedAt: '',
            updatedByDeviceId: '',
            syncStatus: 'pending',
          },
          'CREATE',
        );
      }
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={sharedStyles.content}>
      <Text style={sharedStyles.title}>{existing ? 'Change this schedule' : 'New schedule'}</Text>

      <View style={{ gap: 6 }}>
        <Text style={sharedStyles.label}>Frequency</Text>
        <View style={[sharedStyles.row, { flexWrap: 'wrap' }]}>
          {FREQUENCY_OPTIONS.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              selected={frequencyType === option.value}
              onPress={() => setFrequencyType(option.value)}
            />
          ))}
        </View>
      </View>

      {frequencyType === 'interval_days' && (
        <View>
          <Text style={sharedStyles.label}>Every how many days</Text>
          <TextInput style={sharedStyles.input} keyboardType="numeric" value={intervalDays} onChangeText={setIntervalDays} />
        </View>
      )}

      {frequencyType === 'specific_days' && (
        <View style={{ gap: 6 }}>
          <Text style={sharedStyles.label}>Days of the week</Text>
          <View style={[sharedStyles.row, { flexWrap: 'wrap' }]}>
            {DAY_LABELS.map((label, day) => (
              <Chip key={day} label={label} selected={daysOfWeek.includes(day)} onPress={() => toggleDay(day)} />
            ))}
          </View>
        </View>
      )}

      <View style={{ gap: 8 }}>
        <Text style={sharedStyles.label}>Times of day</Text>
        {timesOfDay.map((time, index) => {
          const invalid = time !== '' && !isValidTime(time);
          return (
            <View key={index} style={{ gap: 4 }}>
              <View style={[sharedStyles.row]}>
                <TextInput
                  style={[sharedStyles.input, { flex: 1 }]}
                  value={time}
                  onChangeText={(value) => updateTime(index, value)}
                  placeholder="HH:MM"
                  placeholderTextColor="#64748b"
                  accessibilityLabel={`Time ${index + 1}`}
                  autoCapitalize="none"
                />
                {timesOfDay.length > 1 && <Button label="Remove" onPress={() => removeTime(index)} />}
              </View>
              {invalid && <Text style={sharedStyles.errorText}>Enter a valid time as HH:MM (e.g. 08:00).</Text>}
            </View>
          );
        })}
        <Button label="+ Add a time" onPress={() => setTimesOfDay((current) => [...current, ''])} />
      </View>

      <View>
        <Text style={sharedStyles.label}>Dose quantity</Text>
        <TextInput style={sharedStyles.input} keyboardType="numeric" value={dosageQuantity} onChangeText={setDosageQuantity} />
      </View>

      {existing ? (
        <View>
          <Text style={sharedStyles.label}>Effective from</Text>
          <TextInput
            style={sharedStyles.input}
            value={effectiveFrom}
            onChangeText={setEffectiveFrom}
            placeholder="YYYY-MM-DD"
            placeholderTextColor="#64748b"
            autoCapitalize="none"
          />
          {!isValidDate(effectiveFrom) && <Text style={sharedStyles.errorText}>Use YYYY-MM-DD format.</Text>}
        </View>
      ) : (
        <View>
          <Text style={sharedStyles.label}>Start date</Text>
          <TextInput
            style={sharedStyles.input}
            value={startDate}
            onChangeText={setStartDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor="#64748b"
            autoCapitalize="none"
          />
          {!isValidDate(startDate) && <Text style={sharedStyles.errorText}>Use YYYY-MM-DD format.</Text>}
        </View>
      )}

      <View>
        <Text style={sharedStyles.label}>End date (optional — for a fixed course like a taper)</Text>
        <TextInput
          style={sharedStyles.input}
          value={endDate}
          onChangeText={setEndDate}
          placeholder="YYYY-MM-DD"
          placeholderTextColor="#64748b"
          autoCapitalize="none"
        />
        {endDate !== '' && !isValidDate(endDate) && <Text style={sharedStyles.errorText}>Use YYYY-MM-DD format.</Text>}
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
 * A selectable "chip" button, standing in for web's `<select>`/checkbox row — RN has no native
 * `<select>`, and this app deliberately doesn't add a dropdown library (see task constraints).
 */
function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }): React.JSX.Element {
  return <Button label={selected ? `✓ ${label}` : label} onPress={onPress} variant={selected ? 'primary' : 'default'} />;
}
