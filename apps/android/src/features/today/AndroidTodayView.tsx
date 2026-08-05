import { useState, useEffect } from 'react';
import {
  SINGLE_PATIENT_ID,
  expandSchedules,
  sortByActualTimeDesc,
  lastAdministeredDose,
  formatLocalTime,
  toIso,
  systemClock,
  uuidIdGenerator,
  type IntakeLog,
  type Medicine,
  type Schedule,
} from '@medguard/shared';
import { androidDb } from '../../db/androidDb.js';
import { M3Card, M3Badge, m3ButtonPrimary, m3ButtonSecondary, m3InputClass } from '../../ui/MaterialComponents.js';

export function AndroidTodayView({ caregiverName }: { caregiverName: string }) {
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [logs, setLogs] = useState<IntakeLog[]>([]);
  const [selectedOverdue, setSelectedOverdue] = useState<{
    medicine: Medicine;
    scheduleId: string;
    scheduledTime: string;
  } | null>(null);
  const [customTime, setCustomTime] = useState('');

  const loadData = async () => {
    const medList = await androidDb.medicines.toArray();
    const schedList = await androidDb.schedules.where('active').equals(1).toArray();
    const logList = await androidDb.intakeLogs.toArray();
    setMedicines(medList);
    setSchedules(schedList);
    setLogs(logList);
  };

  useEffect(() => {
    loadData();
  }, []);

  const nowIso = toIso(systemClock.now());
  const todayDate = nowIso.slice(0, 10);

  // Expand schedules for today using @medguard/shared
  const occurrences = expandSchedules(schedules, {
    startInclusive: `${todayDate}T00:00:00.000Z`,
    endInclusive: `${todayDate}T23:59:59.999Z`,
  });

  const handleMarkTaken = async (medicineId: string, scheduleId?: string, actualTimeIso?: string) => {
    const logTime = actualTimeIso || toIso(systemClock.now());
    const newLog: IntakeLog = {
      id: uuidIdGenerator.generate(),
      patientId: SINGLE_PATIENT_ID,
      medicineId,
      scheduleId,
      type: scheduleId ? 'scheduled' : 'prn',
      status: 'taken',
      actualTime: logTime,
      quantityTaken: 1,
      loggedByUserId: caregiverName,
      syncStatus: 'pending',
    };

    await androidDb.intakeLogs.add(newLog);
    await androidDb.syncOutbox.add({
      table: 'intakeLogs',
      entityId: newLog.id,
      action: 'CREATE',
      payload: newLog,
      createdAt: toIso(systemClock.now()),
    });

    setSelectedOverdue(null);
    await loadData();
  };

  const lastDose = lastAdministeredDose(logs);
  const lastMed = lastDose ? medicines.find((m) => m.id === lastDose.medicineId) : null;

  return (
    <div className="flex flex-col gap-4 p-4 pb-24">
      {/* Last Administered Dose Banner */}
      {lastDose && lastMed && (
        <M3Card className="border-sky-800/50 bg-sky-950/30">
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-xs font-semibold uppercase tracking-wider text-sky-400">
                Last Administered
              </span>
              <span className="text-base font-bold text-slate-100">{lastMed.name}</span>
            </div>
            <M3Badge tone="info">
              {formatLocalTime(lastDose.actualTime)} by {lastDose.loggedByUserId}
            </M3Badge>
          </div>
        </M3Card>
      )}

      {/* Overdue / Custom Time Modal */}
      {selectedOverdue && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-slate-700 bg-slate-900 p-6 shadow-2xl flex flex-col gap-4">
            <h3 className="text-lg font-bold text-slate-100">
              Log {selectedOverdue.medicine.name}
            </h3>
            <p className="text-xs text-slate-400">
              Scheduled for {formatLocalTime(selectedOverdue.scheduledTime)}. When was it actually given?
            </p>

            <button
              onClick={() => handleMarkTaken(selectedOverdue.medicine.id, selectedOverdue.scheduleId, selectedOverdue.scheduledTime)}
              className={m3ButtonPrimary}
            >
              On Time ({formatLocalTime(selectedOverdue.scheduledTime)})
            </button>

            <button
              onClick={() => handleMarkTaken(selectedOverdue.medicine.id, selectedOverdue.scheduleId)}
              className={m3ButtonSecondary}
            >
              Just Now
            </button>

            <div className="flex flex-col gap-1 mt-2">
              <label className="text-xs font-semibold text-slate-400">Custom ISO Time:</label>
              <input
                type="datetime-local"
                className={m3InputClass}
                onChange={(e) => setCustomTime(new Date(e.target.value).toISOString())}
              />
            </div>

            {customTime && (
              <button
                onClick={() => handleMarkTaken(selectedOverdue.medicine.id, selectedOverdue.scheduleId, customTime)}
                className={m3ButtonSecondary}
              >
                Log Custom Time
              </button>
            )}

            <button
              onClick={() => setSelectedOverdue(null)}
              className="mt-2 text-xs font-semibold text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Scheduled Occurrences List */}
      <h2 className="text-lg font-bold tracking-tight text-slate-100">Today's Schedule</h2>

      {occurrences.length === 0 ? (
        <M3Card>
          <p className="text-sm text-slate-400 text-center py-4">No scheduled doses for today.</p>
        </M3Card>
      ) : (
        occurrences.map((occ) => {
          const med = medicines.find((m) => m.id === occ.medicineId);
          if (!med) return null;

          const isTaken = logs.some(
            (l) => l.medicineId === occ.medicineId && l.scheduleId === occ.scheduleId && l.status === 'taken'
          );

          return (
            <M3Card key={`${occ.scheduleId}-${occ.scheduledTime}`}>
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-base font-bold text-slate-100">{med.name}</span>
                  <span className="text-xs text-slate-400">
                    {med.strength} • {formatLocalTime(occ.scheduledTime)}
                  </span>
                </div>

                {isTaken ? (
                  <M3Badge tone="safe">Taken</M3Badge>
                ) : (
                  <button
                    onClick={() => setSelectedOverdue({ medicine: med, scheduleId: occ.scheduleId, scheduledTime: occ.scheduledTime })}
                    className={m3ButtonPrimary}
                  >
                    Mark Taken
                  </button>
                )}
              </div>
            </M3Card>
          );
        })
      )}

      {/* Recent History */}
      <h2 className="text-lg font-bold tracking-tight text-slate-100 mt-4">Recent Log History</h2>
      {sortByActualTimeDesc(logs).slice(0, 5).map((log) => {
        const med = medicines.find((m) => m.id === log.medicineId);
        return (
          <M3Card key={log.id} className="py-3">
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-slate-200">{med?.name || 'Medicine'}</span>
                <span className="text-xs text-slate-400">Logged by {log.loggedByUserId}</span>
              </div>
              <span className="text-xs font-mono text-slate-400">{formatLocalTime(log.actualTime)}</span>
            </div>
          </M3Card>
        );
      })}
    </div>
  );
}
