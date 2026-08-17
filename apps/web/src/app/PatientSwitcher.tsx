import { usePatients } from './PatientProvider.js';
import type { PatientSelection } from './PatientProvider.js';

/**
 * The header control that decides which patient's data every screen shows. "All patients" merges
 * every patient's data with a name badge on each row (see `TodayView`); a specific patient filters
 * down to just them.
 *
 * Hidden entirely for a single-patient household — a switcher with one real option and "All"
 * (which shows the same thing) is a control with nothing to decide.
 */
export function PatientSwitcher() {
  const { patients, selection, select } = usePatients();

  if (patients.length <= 1) {
    return null;
  }

  return (
    <label className="flex items-center gap-1 text-sm">
      <span className="sr-only">Patient</span>
      <select
        aria-label="Patient"
        className="w-auto rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm"
        value={selection}
        onChange={(event) => select(event.target.value as PatientSelection)}
      >
        <option value="all">All patients</option>
        {patients.map((patient) => (
          <option key={patient.id} value={patient.id}>
            {patient.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}
