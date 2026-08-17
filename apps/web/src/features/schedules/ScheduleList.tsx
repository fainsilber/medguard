import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { SINGLE_PATIENT_ID, describeSchedule, formatLocalDate } from '@medguard/shared';
import type { Schedule } from '@medguard/shared';
import { usePatients } from '../../app/PatientProvider.js';
import { useClock, useMedGuardDb, useRepository } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { Badge, buttonClass, inputClass, labelClass } from '../../ui/primitives.js';
import { ScheduleForm } from './ScheduleForm.js';

/**
 * A medicine's schedule history: the live version plus every closed one, since a closed
 * schedule still owns the historical doses it produced (safety invariant 1) and stays visible
 * rather than disappearing.
 *
 * A medicine shared by more than one patient has one schedule *per patient* (never one schedule
 * covering both) — so a shared medicine's history here is really two interleaved histories, told
 * apart by a name badge on each row.
 */
export function ScheduleList({ medicineId }: { medicineId: string }) {
  const db = useMedGuardDb();
  const repository = useRepository();
  const clock = useClock();
  const householdSettings = useHouseholdSettings();
  const { patients } = usePatients();
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const [newSchedulePatientId, setNewSchedulePatientId] = useState<string | null>(null);

  const schedules = useLiveQuery(
    () => db.schedules.where('medicineId').equals(medicineId).toArray(),
    [db, medicineId],
  );

  const assignedPatientIds = useLiveQuery(async () => {
    const rows = await db.medicinePatients.where('medicineId').equals(medicineId).toArray();
    return rows.filter((row) => row.active).map((row) => row.patientId);
  }, [db, medicineId]);

  const assignedPatients = (assignedPatientIds ?? [])
    .map((id) => patients.find((patient) => patient.id === id))
    .filter((patient): patient is (typeof patients)[number] => patient !== undefined)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const patientNames = new Map(patients.map((patient) => [patient.id, patient.displayName]));
  const isShared = assignedPatients.length > 1;

  const today = householdSettings ? formatLocalDate(householdSettings.timeZone, clock.nowMs()) : undefined;

  const startNewSchedule = () => {
    if (isShared) {
      // A shared medicine needs to know *which* patient's schedule this is — there is no single
      // implicit answer the way there is for a private medicine.
      setNewSchedulePatientId(assignedPatients[0]!.id);
    } else {
      setNewSchedulePatientId(assignedPatients[0]?.id ?? SINGLE_PATIENT_ID);
    }
    setEditing('new');
  };

  if (editing && today) {
    const patientId =
      editing === 'new' ? (newSchedulePatientId ?? SINGLE_PATIENT_ID) : editing.patientId;

    return (
      <div className="flex flex-col gap-3">
        {editing === 'new' && isShared && (
          <label className={labelClass}>
            For which patient?
            <select
              className={inputClass}
              value={patientId}
              onChange={(event) => setNewSchedulePatientId(event.target.value)}
            >
              {assignedPatients.map((patient) => (
                <option key={patient.id} value={patient.id}>
                  {patient.displayName}
                </option>
              ))}
            </select>
          </label>
        )}
        <ScheduleForm
          medicineId={medicineId}
          patientId={patientId}
          today={today}
          {...(editing !== 'new' ? { existing: editing } : {})}
          onDone={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  const active = (schedules ?? []).filter((schedule) => schedule.active);
  const past = (schedules ?? []).filter((schedule) => !schedule.active);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-300">Schedule</h3>
        <button type="button" className={buttonClass} onClick={startNewSchedule} disabled={!today}>
          + Add schedule
        </button>
      </div>

      {schedules === undefined || !today ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : active.length === 0 ? (
        <p className="text-sm text-slate-400">No active schedule.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {active.map((schedule) => (
            <li
              key={schedule.id}
              className="flex items-center justify-between rounded-md border border-slate-800 p-2 text-sm"
            >
              <span>
                {isShared && (
                  <Badge tone="neutral">{patientNames.get(schedule.patientId) ?? 'Unknown patient'}</Badge>
                )}{' '}
                {describeSchedule(schedule)}
              </span>
              <div className="flex shrink-0 gap-2">
                <button type="button" className={buttonClass} onClick={() => setEditing(schedule)}>
                  Change
                </button>
                <button
                  type="button"
                  className={buttonClass}
                  onClick={() => void repository.closeSchedule(schedule.id, today)}
                >
                  Stop
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {past.length > 0 && (
        <details className="text-sm text-slate-400">
          <summary>Past schedules ({past.length})</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {past.map((schedule) => (
              <li key={schedule.id}>
                {isShared && (
                  <Badge tone="neutral">{patientNames.get(schedule.patientId) ?? 'Unknown patient'}</Badge>
                )}{' '}
                {describeSchedule(schedule)} — ended {schedule.endDate ?? '(never took effect)'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
