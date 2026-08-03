import { useState } from 'react';
import type { FormEvent } from 'react';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import type { Medicine } from '@medguard/shared';
import { useIdGenerator, useRepository } from '../../app/RepositoryContext.js';
import { buttonClass, inputClass, labelClass, primaryButtonClass } from '../../ui/primitives.js';

const MEDICINE_FORMS = ['pill', 'liquid', 'injection', 'topical', 'other'] as const;

/**
 * Add or edit a medicine. Editing writes the same id back (an in-place field correction, not a
 * new version) — unlike schedules, a medicine's name or PRN guard isn't something that needs a
 * historical trail the way a dose amount does.
 */
export function MedicineForm({
  medicine,
  onDone,
  onCancel,
}: {
  medicine?: Medicine;
  onDone: () => void;
  onCancel: () => void;
}) {
  const repository = useRepository();
  const ids = useIdGenerator();

  const [name, setName] = useState(medicine?.name ?? '');
  const [strength, setStrength] = useState(medicine?.strength ?? '');
  const [form, setForm] = useState<Medicine['form']>(medicine?.form ?? 'pill');
  const [minHours, setMinHours] = useState(medicine?.minHoursBetweenDoses?.toString() ?? '');
  const [maxDaily, setMaxDaily] = useState(medicine?.maxDailyDoses?.toString() ?? '');
  const [instructions, setInstructions] = useState(medicine?.instructions ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    const trimmedStrength = strength.trim();
    if (!trimmedName || !trimmedStrength) {
      setError('Name and strength are required.');
      return;
    }

    const minHoursValue = minHours.trim() === '' ? undefined : Number(minHours);
    if (minHoursValue !== undefined && !(minHoursValue > 0)) {
      setError('Minimum hours between doses must be a positive number.');
      return;
    }

    const maxDailyValue = maxDaily.trim() === '' ? undefined : Number(maxDaily);
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
    <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">{medicine ? 'Edit medicine' : 'Add medicine'}</h2>

      <label className={labelClass}>
        Name
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>

      <label className={labelClass}>
        Strength
        <input
          className={inputClass}
          placeholder="e.g. 50mg"
          value={strength}
          onChange={(e) => setStrength(e.target.value)}
        />
      </label>

      <label className={labelClass}>
        Form
        <select
          className={inputClass}
          value={form}
          onChange={(e) => setForm(e.target.value as Medicine['form'])}
        >
          {MEDICINE_FORMS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className={labelClass}>
          Min hours between doses
          <input
            className={inputClass}
            type="number"
            min="0"
            step="0.5"
            placeholder="PRN only"
            value={minHours}
            onChange={(e) => setMinHours(e.target.value)}
          />
        </label>
        <label className={labelClass}>
          Max doses / day
          <input
            className={inputClass}
            type="number"
            min="1"
            step="1"
            placeholder="PRN only"
            value={maxDaily}
            onChange={(e) => setMaxDaily(e.target.value)}
          />
        </label>
      </div>

      <label className={labelClass}>
        Instructions
        <textarea
          className={inputClass}
          rows={2}
          placeholder="e.g. Take on an empty stomach"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
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
