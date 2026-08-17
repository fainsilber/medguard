import { useState } from 'react';
import type { FormEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Patient } from '@medguard/shared';
import { useClock, useIdGenerator, useMedGuardDb, useRepository } from '../../app/RepositoryContext.js';
import { Card, buttonClass, inputClass, primaryButtonClass } from '../../ui/primitives.js';

/**
 * Add, rename, reorder, and archive the patients this household tracks medicine for.
 *
 * Archive only, never delete: medicines, schedules, and intake logs reference a patient forever
 * (safety invariant 1), and an export or a safety banner still needs to be able to name them —
 * the same reason `archiveMedicine` exists instead of a delete.
 */
export function PatientRosterCard() {
  const db = useMedGuardDb();
  const repository = useRepository();
  const ids = useIdGenerator();
  const clock = useClock();

  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const all = useLiveQuery(() => db.patients.toArray(), [db]);
  const active = (all ?? []).filter((p) => !p.archived).sort((a, b) => a.sortOrder - b.sortOrder);
  const archived = (all ?? []).filter((p) => p.archived);

  const handleAdd = async (event: FormEvent) => {
    event.preventDefault();
    const displayName = newName.trim();
    if (!displayName) return;

    setAdding(true);
    try {
      const nextSortOrder = active.length === 0 ? 0 : Math.max(...active.map((p) => p.sortOrder)) + 1;
      await repository.savePatient(
        {
          id: ids.next(),
          displayName,
          archived: false,
          sortOrder: nextSortOrder,
          updatedAt: clock.nowIso(),
          updatedByDeviceId: '',
          syncStatus: 'pending',
        },
        'CREATE',
      );
      setNewName('');
    } finally {
      setAdding(false);
    }
  };

  const startRename = (patient: Patient) => {
    setRenamingId(patient.id);
    setRenameValue(patient.displayName);
  };

  const commitRename = async (patient: Patient) => {
    const displayName = renameValue.trim();
    setRenamingId(null);
    if (!displayName || displayName === patient.displayName) return;
    await repository.savePatient({ ...patient, displayName });
  };

  const handleArchive = async (patient: Patient) => {
    await repository.archivePatient(patient.id);
  };

  const handleRestore = async (patient: Patient) => {
    await repository.savePatient({ ...patient, archived: false });
  };

  const move = async (patient: Patient, direction: -1 | 1) => {
    const index = active.findIndex((p) => p.id === patient.id);
    const neighborIndex = index + direction;
    const neighbor = active[neighborIndex];
    if (!neighbor) return;

    // Swap sortOrder values rather than renumbering the whole list — two writes, unaffected by
    // how many other patients exist.
    await repository.savePatient({ ...patient, sortOrder: neighbor.sortOrder });
    await repository.savePatient({ ...neighbor, sortOrder: patient.sortOrder });
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold">Patients</h2>
      <p className="text-sm text-slate-400">
        Everyone in this household whose medicines are tracked. A medicine can belong to one
        patient or be shared across several.
      </p>

      <ul className="flex flex-col gap-2">
        {active.map((patient, index) => (
          <li
            key={patient.id}
            className="flex items-center justify-between gap-2 rounded-md border border-slate-800 p-2 text-sm"
          >
            {renamingId === patient.id ? (
              <form
                className="flex flex-1 items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void commitRename(patient);
                }}
              >
                <input
                  className={inputClass}
                  value={renameValue}
                  autoFocus
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => void commitRename(patient)}
                  aria-label={`Rename ${patient.displayName}`}
                />
                <button type="submit" className={buttonClass}>
                  Save
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="flex-1 text-left font-medium"
                onClick={() => startRename(patient)}
              >
                {patient.displayName}
              </button>
            )}

            <div className="flex items-center gap-1">
              <button
                type="button"
                className={buttonClass}
                disabled={index === 0}
                aria-label={`Move ${patient.displayName} up`}
                onClick={() => void move(patient, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className={buttonClass}
                disabled={index === active.length - 1}
                aria-label={`Move ${patient.displayName} down`}
                onClick={() => void move(patient, 1)}
              >
                ↓
              </button>
              <button type="button" className={buttonClass} onClick={() => void handleArchive(patient)}>
                Archive
              </button>
            </div>
          </li>
        ))}
        {active.length === 0 && <p className="text-sm text-slate-400">No patients yet.</p>}
      </ul>

      <form className="flex gap-2" onSubmit={(event) => void handleAdd(event)}>
        <input
          className={inputClass}
          placeholder="Patient name"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          aria-label="New patient name"
        />
        <button type="submit" className={primaryButtonClass} disabled={adding || !newName.trim()}>
          Add
        </button>
      </form>

      {archived.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-slate-800 pt-3">
          <button type="button" className={buttonClass} onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Hide' : 'Show'} archived ({archived.length})
          </button>
          {showArchived && (
            <ul className="flex flex-col gap-2">
              {archived.map((patient) => (
                <li
                  key={patient.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-slate-800 p-2 text-sm text-slate-400"
                >
                  <span>{patient.displayName}</span>
                  <button type="button" className={buttonClass} onClick={() => void handleRestore(patient)}>
                    Restore
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
