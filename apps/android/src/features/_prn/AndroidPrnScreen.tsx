import { useState, useEffect } from 'react';
import {
  SINGLE_PATIENT_ID,
  assessDose,
  formatLocalTime,
  toIso,
  systemClock,
  uuidIdGenerator,
  type IntakeLog,
  type Medicine,
} from '@medguard/shared';
import { androidDb } from '../../db/androidDb.js';
import {
  M3Card,
  M3Badge,
  m3ButtonPrimary,
  m3ButtonDanger,
  m3InputClass,
} from '../../ui/MaterialComponents.js';

export function AndroidPrnScreen({ caregiverName }: { caregiverName: string }) {
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [logs, setLogs] = useState<IntakeLog[]>([]);
  const [overrideTarget, setOverrideTarget] = useState<Medicine | null>(null);
  const [overrideReason, setOverrideReason] = useState('');

  const loadData = async () => {
    const medList = await androidDb.medicines.toArray();
    const logList = await androidDb.intakeLogs.toArray();
    setMedicines(medList.filter((m) => m.minHoursBetweenDoses || m.maxDailyDoses));
    setLogs(logList);
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleAdministerPrn = async (medicine: Medicine, isOverride = false) => {
    const nowIso = toIso(systemClock.now());
    const newLog: IntakeLog = {
      id: uuidIdGenerator.generate(),
      patientId: SINGLE_PATIENT_ID,
      medicineId: medicine.id,
      type: 'prn',
      status: 'taken',
      actualTime: nowIso,
      quantityTaken: 1,
      loggedByUserId: caregiverName,
      notes: isOverride ? `OVERRIDE: ${overrideReason}` : undefined,
      syncStatus: 'pending',
    };

    await androidDb.intakeLogs.add(newLog);
    await androidDb.syncOutbox.add({
      table: 'intakeLogs',
      entityId: newLog.id,
      action: 'CREATE',
      payload: newLog,
      createdAt: nowIso,
    });

    setOverrideTarget(null);
    setOverrideReason('');
    await loadData();
  };

  return (
    <div className="flex flex-col gap-4 p-4 pb-24">
      <div className="flex flex-col">
        <h2 className="text-xl font-bold tracking-tight text-slate-100">As Needed (PRN) Safety</h2>
        <p className="text-xs text-slate-400">
          Enforces minimum cooldown intervals and rolling 24-hour daily dose caps.
        </p>
      </div>

      {/* Safety Override Confirmation Modal */}
      {overrideTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-rose-800 bg-slate-900 p-6 shadow-2xl flex flex-col gap-4">
            <div className="flex items-center gap-2">
              <span className="h-3 w-3 rounded-full bg-rose-500 animate-pulse" />
              <h3 className="text-lg font-bold text-rose-300">Safety Override Required</h3>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              {overrideTarget.name} is currently locked by safety cooldown limits. To bypass safety restrictions, enter a mandatory reason.
            </p>

            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-slate-400">Override Reason:</label>
              <input
                type="text"
                placeholder="e.g., Doctor instructed phone override"
                className={m3InputClass}
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
              />
            </div>

            <button
              disabled={!overrideReason.trim()}
              onClick={() => handleAdministerPrn(overrideTarget, true)}
              className={m3ButtonDanger}
            >
              Confirm Double-Lock Override
            </button>

            <button
              onClick={() => {
                setOverrideTarget(null);
                setOverrideReason('');
              }}
              className="text-xs font-semibold text-slate-400 hover:text-slate-200 mt-1"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* PRN Medicines List with Safety Guard Evaluation */}
      {medicines.length === 0 ? (
        <M3Card>
          <p className="text-sm text-slate-400 text-center py-4">
            No PRN medications configured with safety guards.
          </p>
        </M3Card>
      ) : (
        medicines.map((med) => {
          // Pure domain evaluation via @medguard/shared safety module
          const safety = assessDose({
            medicine: med,
            history: logs,
            clock: systemClock,
          });

          const isPermitted = safety.permitted;
          const statusTone = isPermitted
            ? 'safe'
            : safety.blockReason === 'cap'
            ? 'capped'
            : 'locked';

          return (
            <M3Card key={med.id} className="border-l-4 border-l-slate-700">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-lg font-bold text-slate-100">{med.name}</span>
                    <span className="text-xs text-slate-400">
                      {med.strength} • Min gap: {med.minHoursBetweenDoses || 0}h • Max 24h: {med.maxDailyDoses || 'Unlimited'}
                    </span>
                  </div>
                  <M3Badge tone={statusTone}>
                    {isPermitted ? '🟢 Safe' : safety.blockReason === 'cap' ? '⚫ Capped' : '🔴 Locked'}
                  </M3Badge>
                </div>

                {!isPermitted && safety.availableAtIso && (
                  <div className="rounded-xl bg-rose-950/40 border border-rose-800/40 p-3 text-xs text-rose-300">
                    Locked until <span className="font-bold">{formatLocalTime(safety.availableAtIso)}</span>
                  </div>
                )}

                <div className="flex items-center justify-between mt-1">
                  {isPermitted ? (
                    <button
                      onClick={() => handleAdministerPrn(med)}
                      className={m3ButtonPrimary}
                    >
                      Give PRN Dose
                    </button>
                  ) : (
                    <button
                      onClick={() => setOverrideTarget(med)}
                      className={m3ButtonDanger}
                    >
                      Override Safety Lock
                    </button>
                  )}
                </div>
              </div>
            </M3Card>
          );
        })
      )}
    </div>
  );
}
