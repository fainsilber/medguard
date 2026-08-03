import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import type { Medicine } from '@medguard/shared';
import { useMedGuardDb, useRepository } from '../../app/RepositoryContext.js';
import { ScheduleList } from '../schedules/ScheduleList.js';
import { Badge, Card, buttonClass, primaryButtonClass } from '../../ui/primitives.js';
import { MedicineForm } from './MedicineForm.js';

/**
 * Medicines are archived, never deleted (safety invariant 1's spirit extended to the medicine
 * record itself) — intake logs reference them forever, and deleting one would orphan a
 * patient's dosing history.
 */
export function MedicineList() {
  const db = useMedGuardDb();
  const repository = useRepository();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Medicine | 'new' | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const medicines = useLiveQuery(
    () =>
      showArchived
        ? db.medicines.toArray()
        : db.medicines.filter((medicine) => !medicine.archived).toArray(),
    [db, showArchived],
  );

  if (editing) {
    return (
      <Card>
        <MedicineForm
          {...(editing !== 'new' ? { medicine: editing } : {})}
          onDone={() => setEditing(null)}
          onCancel={() => setEditing(null)}
        />
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Medicines</h2>
        <button type="button" className={primaryButtonClass} onClick={() => setEditing('new')}>
          + Add medicine
        </button>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-400">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(event) => setShowArchived(event.target.checked)}
        />
        Show archived
      </label>

      {medicines === undefined ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : medicines.length === 0 ? (
        <p className="text-sm text-slate-400">No medicines yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {medicines.map((medicine) => (
            <li
              key={medicine.id}
              className="flex items-center justify-between gap-3 rounded-md border border-slate-800 p-3"
            >
              <div>
                <p className="font-medium">
                  {medicine.name} <span className="text-slate-400">{medicine.strength}</span>
                  {medicine.asNeeded && <Badge tone="neutral">as needed</Badge>}
                  {medicine.archived && <Badge tone="neutral">archived</Badge>}
                </p>
                {(medicine.minHoursBetweenDoses !== undefined ||
                  medicine.maxDailyDoses !== undefined) && (
                  <p className="text-xs text-slate-400">
                    {medicine.minHoursBetweenDoses !== undefined &&
                      `Min ${medicine.minHoursBetweenDoses}h between doses`}
                    {medicine.minHoursBetweenDoses !== undefined &&
                      medicine.maxDailyDoses !== undefined &&
                      ' · '}
                    {medicine.maxDailyDoses !== undefined && `Max ${medicine.maxDailyDoses}/day`}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {!medicine.asNeeded && (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => setExpandedId((current) => (current === medicine.id ? null : medicine.id))}
                  >
                    {expandedId === medicine.id ? 'Hide schedule' : 'Schedule'}
                  </button>
                )}
                <button type="button" className={buttonClass} onClick={() => setEditing(medicine)}>
                  Edit
                </button>
                {!medicine.archived && (
                  <button
                    type="button"
                    className={buttonClass}
                    onClick={() => void repository.archiveMedicine(medicine.id)}
                  >
                    Archive
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {expandedId && (
        <div className="rounded-md border border-slate-800 p-3">
          <p className="mb-2 text-xs text-slate-500">
            Schedule for {medicines?.find((medicine) => medicine.id === expandedId)?.name ?? 'this medicine'}
          </p>
          <ScheduleList medicineId={expandedId} />
        </div>
      )}
    </Card>
  );
}
