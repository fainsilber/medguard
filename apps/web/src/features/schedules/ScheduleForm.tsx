import { useState } from 'react';
import type { FormEvent } from 'react';
import { DAY_LABELS, SINGLE_PATIENT_ID } from '@medguard/shared';
import type { FrequencyType, LocalDate, Schedule } from '@medguard/shared';
import { useIdGenerator, useRepository } from '../../app/RepositoryContext.js';
import { buttonClass, inputClass, labelClass, primaryButtonClass } from '../../ui/primitives.js';

/**
 * Create a new schedule, or revise an existing one.
 *
 * Revising never edits in place (PRD §2.2 — "modifying a dose updates future scheduled events
 * without mutating historical intake logs"): submitting against an existing schedule closes it
 * and creates a new version effective from the chosen date, via the shared `reviseSchedule`
 * logic. The caregiver only ever sees "save"; the versioning happens underneath.
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
}) {
  const repository = useRepository();
  const ids = useIdGenerator();

  const [frequencyType, setFrequencyType] = useState<FrequencyType>(
    existing?.frequencyType ?? 'daily',
  );
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
    setDaysOfWeek((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort(),
    );
  };

  const updateTime = (index: number, value: string) => {
    setTimesOfDay((current) => current.map((time, i) => (i === index ? value : time)));
  };

  const removeTime = (index: number) => {
    setTimesOfDay((current) => current.filter((_, i) => i !== index));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const cleanTimes = [...new Set(timesOfDay.filter((time) => time !== ''))].sort();
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
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">
        {existing ? 'Change this schedule' : 'New schedule'}
      </h3>

      <label className={labelClass}>
        Frequency
        <select
          className={inputClass}
          value={frequencyType}
          onChange={(e) => setFrequencyType(e.target.value as FrequencyType)}
        >
          <option value="daily">Every day</option>
          <option value="interval_days">Every N days</option>
          <option value="specific_days">Specific days of the week</option>
        </select>
      </label>

      {frequencyType === 'interval_days' && (
        <label className={labelClass}>
          Every how many days
          <input
            className={inputClass}
            type="number"
            min="1"
            step="1"
            value={intervalDays}
            onChange={(e) => setIntervalDays(e.target.value)}
          />
        </label>
      )}

      {frequencyType === 'specific_days' && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm">Days of the week</legend>
          <div className="flex flex-wrap gap-2">
            {DAY_LABELS.map((label, day) => (
              <label key={day} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  checked={daysOfWeek.includes(day)}
                  onChange={() => toggleDay(day)}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm">Times of day</legend>
        {timesOfDay.map((time, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              className={inputClass}
              type="time"
              value={time}
              onChange={(e) => updateTime(index, e.target.value)}
              aria-label={`Time ${index + 1}`}
            />
            {timesOfDay.length > 1 && (
              <button type="button" className={buttonClass} onClick={() => removeTime(index)}>
                Remove
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className={buttonClass}
          onClick={() => setTimesOfDay((current) => [...current, ''])}
        >
          + Add a time
        </button>
      </fieldset>

      <label className={labelClass}>
        Dose quantity
        <input
          className={inputClass}
          type="number"
          min="0"
          step="0.5"
          value={dosageQuantity}
          onChange={(e) => setDosageQuantity(e.target.value)}
        />
      </label>

      {existing ? (
        <label className={labelClass}>
          Effective from
          <input
            className={inputClass}
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </label>
      ) : (
        <label className={labelClass}>
          Start date
          <input
            className={inputClass}
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </label>
      )}

      <label className={labelClass}>
        End date (optional — for a fixed course like a taper)
        <input
          className={inputClass}
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
        />
      </label>

      {error && (
        <p className="text-locked text-sm" role="alert">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button type="submit" className={primaryButtonClass} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className={buttonClass} onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
