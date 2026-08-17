import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Medicine } from '@medguard/shared';
import { usePatients } from '../../app/PatientProvider.js';
import { useIdGenerator, useMedGuardDb, useRepository } from '../../app/RepositoryContext.js';
import { buttonClass, inputClass, labelClass, primaryButtonClass } from '../../ui/primitives.js';

const MEDICINE_FORMS = ['pill', 'liquid', 'injection', 'topical', 'other'] as const;

/**
 * Add or edit a medicine. Editing writes the same id back (an in-place field correction, not a
 * new version) — unlike schedules, a medicine's name or as-needed guard isn't something that
 * needs a historical trail the way a dose amount does.
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
  const db = useMedGuardDb();
  const repository = useRepository();
  const ids = useIdGenerator();
  const { patients, filterPatientId } = usePatients();

  const existingAssignments = useLiveQuery(
    () => (medicine ? db.medicinePatients.where('medicineId').equals(medicine.id).toArray() : []),
    [db, medicine?.id],
  );

  const [name, setName] = useState(medicine?.name ?? '');
  const [strength, setStrength] = useState(medicine?.strength ?? '');
  const [form, setForm] = useState<Medicine['form']>(medicine?.form ?? 'pill');
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
        new Set(existingAssignments.filter((a) => a.active).map((a) => a.patientId)),
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

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
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
        (existingAssignments ?? []).filter((a) => a.active).map((a) => a.patientId),
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

      {patients.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm">Who takes this?</legend>
          <p className="text-xs text-slate-400">
            Assign to more than one patient to share it — one bottle, one stock count, tracked
            once.
          </p>
          {patients.map((patient) => (
            <label key={patient.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedPatientIds.has(patient.id)}
                onChange={() => togglePatient(patient.id)}
              />
              {patient.displayName}
            </label>
          ))}
        </fieldset>
      )}

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm">How is it taken?</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="asNeeded" checked={!asNeeded} onChange={() => setAsNeeded(false)} />
          On a schedule (set on the medicine&rsquo;s own page after saving)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="asNeeded" checked={asNeeded} onChange={() => setAsNeeded(true)} />
          As needed — no fixed times, given when it&rsquo;s needed
        </label>
      </fieldset>

      {asNeeded && (
        <div className="grid grid-cols-2 gap-3">
          <label className={labelClass}>
            Min hours between doses
            <input
              className={inputClass}
              type="number"
              min="0"
              step="0.5"
              placeholder="optional"
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
              placeholder="optional"
              value={maxDaily}
              onChange={(e) => setMaxDaily(e.target.value)}
            />
          </label>
        </div>
      )}

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
