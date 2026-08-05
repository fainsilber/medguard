import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { SINGLE_PATIENT_ID, formatLocalDate } from '@medguard/shared';
import type { Medicine, MedicineForm, Schedule } from '@medguard/shared';
import {
  useClock,
  useCurrentDeviceId,
  useIdGenerator,
  useMedGuardDb,
  useRepository,
} from '../../app/AndroidAppProvider.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { M3Badge, M3Card, m3ButtonPrimary, m3InputClass } from '../../ui/MaterialComponents.js';

const FORMS: readonly MedicineForm[] = ['pill', 'liquid', 'injection', 'topical', 'other'];

/** Parses an optional numeric field, treating blank and nonsense alike as "not configured". */
function optionalPositiveNumber(raw: string): number | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function AndroidMedicineScreen() {
  const db = useMedGuardDb();
  const repository = useRepository();
  const clock = useClock();
  const ids = useIdGenerator();
  const deviceId = useCurrentDeviceId();
  const household = useHouseholdSettings();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [strength, setStrength] = useState('');
  const [form, setForm] = useState<MedicineForm>('pill');
  const [asNeeded, setAsNeeded] = useState(true);
  const [minHours, setMinHours] = useState('');
  const [maxDaily, setMaxDaily] = useState('');
  const [scheduledTime, setScheduledTime] = useState('08:00');
  const [error, setError] = useState<string | null>(null);

  const medicines = useLiveQuery(() => db.medicines.toArray(), [db]);
  const schedules = useLiveQuery(() => db.schedules.toArray(), [db]);

  const resetForm = () => {
    setName('');
    setStrength('');
    setForm('pill');
    setAsNeeded(true);
    setMinHours('');
    setMaxDaily('');
    setScheduledTime('08:00');
    setError(null);
  };

  const save = async () => {
    if (!name.trim() || !strength.trim()) {
      setError('Name and strength are both required.');
      return;
    }
    if (!household) {
      setError('Household settings are still loading.');
      return;
    }

    const minHoursBetweenDoses = optionalPositiveNumber(minHours);
    const maxDailyDoses = optionalPositiveNumber(maxDaily);

    const medicine: Medicine = {
      id: ids.next(),
      patientId: SINGLE_PATIENT_ID,
      name: name.trim(),
      strength: strength.trim(),
      form,
      asNeeded,
      archived: false,
      // Guards are only meaningful on an as-needed medicine, so they are not carried over from
      // the form when the caregiver switches it to scheduled.
      ...(asNeeded && minHoursBetweenDoses !== undefined ? { minHoursBetweenDoses } : {}),
      ...(asNeeded && maxDailyDoses !== undefined ? { maxDailyDoses } : {}),
      // Overwritten by the repository's own stamp; placeholders satisfy the type.
      updatedAt: '',
      updatedByDeviceId: '',
      syncStatus: 'pending',
    };

    await repository.saveMedicine(medicine, 'CREATE');

    if (!asNeeded) {
      const schedule: Schedule = {
        id: ids.next(),
        medicineId: medicine.id,
        patientId: SINGLE_PATIENT_ID,
        frequencyType: 'daily',
        timesOfDay: [scheduledTime],
        dosageQuantity: 1,
        // A local calendar date in the household timezone, not a UTC slice of the ISO instant —
        // those differ either side of midnight and would start the schedule on the wrong day.
        startDate: formatLocalDate(household.timeZone, clock.nowMs()),
        active: true,
        updatedAt: '',
        updatedByDeviceId: deviceId,
        syncStatus: 'pending',
      };
      await repository.saveSchedule(schedule, 'CREATE');
    }

    resetForm();
    setShowForm(false);
  };

  return (
    <div className="flex flex-col gap-4 p-4 pb-28">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-bold tracking-tight text-slate-100">Medicines</h2>
        <button
          onClick={() => {
            setShowForm(!showForm);
            setError(null);
          }}
          className={m3ButtonPrimary}
        >
          {showForm ? 'Cancel' : 'Add medicine'}
        </button>
      </div>

      {showForm && (
        <M3Card className="border-sky-800/80 bg-slate-900/90">
          <h3 className="text-base font-bold text-slate-100">New medicine</h3>

          <div className="mt-2 flex flex-col gap-3">
            <label htmlFor="medicine-name" className="text-xs font-semibold text-slate-400">
              Medicine name
            </label>
            <input
              id="medicine-name"
              type="text"
              placeholder="e.g. Ondansetron"
              className={m3InputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />

            <label htmlFor="medicine-strength" className="text-xs font-semibold text-slate-400">
              Strength
            </label>
            {/* Free text, exactly as printed on the label — never parsed. The app does no dose math. */}
            <input
              id="medicine-strength"
              type="text"
              placeholder="e.g. 4mg"
              className={m3InputClass}
              value={strength}
              onChange={(event) => setStrength(event.target.value)}
            />

            <label htmlFor="medicine-form" className="text-xs font-semibold text-slate-400">
              Form
            </label>
            <select
              id="medicine-form"
              className={m3InputClass}
              value={form}
              onChange={(event) => setForm(event.target.value as MedicineForm)}
            >
              {FORMS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>

            <div className="flex items-center gap-2 py-2">
              <input
                type="checkbox"
                id="as-needed"
                checked={asNeeded}
                onChange={(event) => setAsNeeded(event.target.checked)}
                className="h-5 w-5 rounded border-slate-700 bg-slate-900 text-sky-600 focus:ring-sky-500"
              />
              <label htmlFor="as-needed" className="text-sm font-semibold text-slate-200">
                As needed (PRN)
              </label>
            </div>

            {asNeeded ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="min-hours" className="text-xs font-semibold text-slate-400">
                    Min cooldown (hours)
                  </label>
                  <input
                    id="min-hours"
                    type="number"
                    placeholder="4"
                    className={m3InputClass}
                    value={minHours}
                    onChange={(event) => setMinHours(event.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="max-daily" className="text-xs font-semibold text-slate-400">
                    Max doses / 24h
                  </label>
                  <input
                    id="max-daily"
                    type="number"
                    placeholder="4"
                    className={m3InputClass}
                    value={maxDaily}
                    onChange={(event) => setMaxDaily(event.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div>
                <label htmlFor="scheduled-time" className="text-xs font-semibold text-slate-400">
                  Scheduled time
                </label>
                <input
                  id="scheduled-time"
                  type="time"
                  className={m3InputClass}
                  value={scheduledTime}
                  onChange={(event) => setScheduledTime(event.target.value)}
                />
              </div>
            )}

            {error && (
              <p role="alert" className="text-xs font-semibold text-rose-400">
                {error}
              </p>
            )}

            <button onClick={() => void save()} className={m3ButtonPrimary}>
              Save medicine
            </button>
          </div>
        </M3Card>
      )}

      {medicines && medicines.length === 0 ? (
        <M3Card>
          <p className="py-4 text-center text-sm text-slate-400">
            No medicines configured yet. Tap &ldquo;Add medicine&rdquo; above.
          </p>
        </M3Card>
      ) : (
        (medicines ?? []).map((medicine) => {
          const schedule = (schedules ?? []).find(
            (candidate) => candidate.medicineId === medicine.id && candidate.active,
          );

          return (
            <M3Card key={medicine.id}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-base font-bold text-slate-100">{medicine.name}</span>
                  <span className="text-xs text-slate-400">
                    {medicine.strength} • {medicine.form}
                  </span>
                </div>
                <M3Badge tone={medicine.asNeeded ? 'info' : 'neutral'}>
                  {medicine.asNeeded ? 'PRN' : 'Scheduled'}
                </M3Badge>
              </div>

              <div className="flex flex-wrap gap-3 border-t border-slate-800/80 pt-2 text-xs text-slate-400">
                {medicine.minHoursBetweenDoses !== undefined && (
                  <span>Min gap: {medicine.minHoursBetweenDoses}h</span>
                )}
                {medicine.maxDailyDoses !== undefined && (
                  <span>Max daily: {medicine.maxDailyDoses}</span>
                )}
                {schedule && <span>Daily at {schedule.timesOfDay.join(', ')}</span>}
              </div>
            </M3Card>
          );
        })
      )}
    </div>
  );
}
