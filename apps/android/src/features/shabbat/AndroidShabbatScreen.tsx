import { useState, useEffect } from 'react';
import {
  SINGLE_PATIENT_ID,
  toIso,
  systemClock,
  uuidIdGenerator,
  type IntakeLog,
  type Medicine,
  type Schedule,
} from '@medguard/shared';
import { androidDb } from '../../db/androidDb.js';
import { androidNativeBridge } from '../../native/androidBridge.js';
import {
  M3Card,
  M3Badge,
  m3ButtonPrimary,
  m3ButtonSecondary,
} from '../../ui/MaterialComponents.js';

export function AndroidShabbatScreen({ caregiverName }: { caregiverName: string }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [selectedMeds, setSelectedMeds] = useState<string[]>([]);
  const [reconciled, setReconciled] = useState(false);

  const loadData = async () => {
    const medList = await androidDb.medicines.toArray();
    const schedList = await androidDb.schedules.toArray();
    setMedicines(medList);
    setSchedules(schedList);
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleTestChime = () => {
    if (isPlaying) {
      androidNativeBridge.stopShabbatChime();
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      androidNativeBridge.startShabbatChime(15, () => {
        setIsPlaying(false);
      });
    }
  };

  const handleBulkReconcile = async () => {
    if (selectedMeds.length === 0) return;
    const nowIso = toIso(systemClock.now());

    for (const medId of selectedMeds) {
      const sched = schedules.find((s) => s.medicineId === medId && s.active);
      const newLog: IntakeLog = {
        id: uuidIdGenerator.generate(),
        patientId: SINGLE_PATIENT_ID,
        medicineId: medId,
        scheduleId: sched?.id,
        type: sched ? 'scheduled' : 'prn',
        status: 'taken',
        actualTime: nowIso,
        quantityTaken: 1,
        loggedByUserId: caregiverName,
        notes: 'Motzei Shabbat Reconciliation',
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
    }

    setReconciled(true);
    setSelectedMeds([]);
    setTimeout(() => setReconciled(false), 4000);
  };

  return (
    <div className="flex flex-col gap-4 p-4 pb-24">
      <div className="flex flex-col">
        <h2 className="text-xl font-bold tracking-tight text-slate-100">Shabbat & Yom Tov Automation</h2>
        <p className="text-xs text-slate-400">
          Android Native 45s audio chime (runs without screen wake) & Motzei Shabbat reconciliation.
        </p>
      </div>

      {/* Android Native Chime Engine Card */}
      <M3Card className="border-sky-800 bg-sky-950/20">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-base font-bold text-slate-100">Android Shabbat Chime Engine</span>
            <span className="text-xs text-slate-400">
              Plays 45s auto-stopping chime tone over Android NotificationChannel
            </span>
          </div>

          <button
            onClick={handleTestChime}
            className={isPlaying ? m3ButtonSecondary : m3ButtonPrimary}
          >
            {isPlaying ? 'Stop Chime' : 'Test 15s Chime'}
          </button>
        </div>
      </M3Card>

      {/* Motzei Shabbat Reconciliation Sheet */}
      <div className="flex flex-col gap-2 mt-4">
        <h3 className="text-lg font-bold text-slate-100">Motzei Shabbat Reconciliation Sheet</h3>
        <p className="text-xs text-slate-400">
          Select doses given over Shabbat/Yom Tov to bulk log and reconcile inventory with one tap.
        </p>

        {reconciled && (
          <M3Card className="bg-emerald-950/60 border-emerald-600/60">
            <p className="text-sm font-semibold text-emerald-300">
              ✅ Motzei Shabbat logs recorded and synced!
            </p>
          </M3Card>
        )}

        {medicines.map((med) => {
          const isSelected = selectedMeds.includes(med.id);
          return (
            <M3Card
              key={med.id}
              onClick={() => {
                if (isSelected) {
                  setSelectedMeds(selectedMeds.filter((id) => id !== med.id));
                } else {
                  setSelectedMeds([...selectedMeds, med.id]);
                }
              }}
              className={isSelected ? 'border-sky-500 bg-sky-950/40' : ''}
            >
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-base font-bold text-slate-100">{med.name}</span>
                  <span className="text-xs text-slate-400">{med.strength}</span>
                </div>
                <M3Badge tone={isSelected ? 'safe' : 'neutral'}>
                  {isSelected ? 'Selected' : 'Tap to Select'}
                </M3Badge>
              </div>
            </M3Card>
          );
        })}

        {selectedMeds.length > 0 && (
          <button onClick={handleBulkReconcile} className={`${m3ButtonPrimary} mt-2`}>
            Bulk Confirm {selectedMeds.length} Shabbat Doses
          </button>
        )}
      </div>
    </div>
  );
}
