import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { formatLocalDate } from '@medguard/shared';
import type { Schedule } from '@medguard/shared';
import { useClock, useMedGuardDb, useRepository } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { buttonClass } from '../../ui/primitives.js';
import { ScheduleForm } from './ScheduleForm.js';
import { describeSchedule } from './scheduleDisplay.js';

/**
 * A medicine's schedule history: the live version plus every closed one, since a closed
 * schedule still owns the historical doses it produced (safety invariant 1) and stays visible
 * rather than disappearing.
 */
export function ScheduleList({ medicineId }: { medicineId: string }) {
  const db = useMedGuardDb();
  const repository = useRepository();
  const clock = useClock();
  const householdSettings = useHouseholdSettings();
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);

  const schedules = useLiveQuery(
    () => db.schedules.where('medicineId').equals(medicineId).toArray(),
    [db, medicineId],
  );

  const today = householdSettings ? formatLocalDate(householdSettings.timeZone, clock.nowMs()) : undefined;

  if (editing && today) {
    return (
      <ScheduleForm
        medicineId={medicineId}
        today={today}
        {...(editing !== 'new' ? { existing: editing } : {})}
        onDone={() => setEditing(null)}
        onCancel={() => setEditing(null)}
      />
    );
  }

  const active = (schedules ?? []).filter((schedule) => schedule.active);
  const past = (schedules ?? []).filter((schedule) => !schedule.active);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-300">Schedule</h3>
        <button
          type="button"
          className={buttonClass}
          onClick={() => setEditing('new')}
          disabled={!today}
        >
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
              <span>{describeSchedule(schedule)}</span>
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
                {describeSchedule(schedule)} — ended {schedule.endDate ?? '(never took effect)'}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
