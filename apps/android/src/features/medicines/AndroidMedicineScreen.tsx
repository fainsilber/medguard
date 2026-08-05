import { useState, useEffect } from 'react';
import {
  SINGLE_PATIENT_ID,
  toIso,
  systemClock,
  uuidIdGenerator,
  type Medicine,
  type Schedule,
} from '@medguard/shared';
import { androidDb } from '../../db/androidDb.js';
import {
  M3Card,
  M3Badge,
  m3ButtonPrimary,
  m3InputClass,
} from '../../ui/MaterialComponents.js';

export function AndroidMedicineScreen() {
  const [medicines, setMedicines] = useState<Medicine[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);

  // Form state
  const [name, setName] = useState('');
  const [strength, setStrength] = useState('');
  const [form] = useState<'pill' | 'liquid' | 'injection' | 'topical' | 'other'>('pill');
  const [minHoursBetweenDoses, setMinHours] = useState('');
  const [maxDailyDoses, setMaxDoses] = useState('');
  const [isAsNeeded, setIsAsNeeded] = useState(true);
  const [scheduledTime, setScheduledTime] = useState('08:00');

  const loadData = async () => {
    const medList = await androidDb.medicines.toArray();
    const schedList = await androidDb.schedules.toArray();
    setMedicines(medList);
    setSchedules(schedList);
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSaveMedicine = async () => {
    if (!name.trim() || !strength.trim()) return;

    const nowIso = toIso(systemClock.now());
    const newMed: Medicine = {
      id: uuidIdGenerator.generate(),
      patientId: SINGLE_PATIENT_ID,
      name,
      strength,
      form,
      asNeeded: isAsNeeded,
      minHoursBetweenDoses: minHoursBetweenDoses ? Number(minHoursBetweenDoses) : undefined,
      maxDailyDoses: maxDailyDoses ? Number(maxDailyDoses) : undefined,
      updatedAt: nowIso,
      syncStatus: 'pending',
    };

    await androidDb.medicines.add(newMed);
    await androidDb.syncOutbox.add({
      table: 'medicines',
      entityId: newMed.id,
      action: 'CREATE',
      payload: newMed,
      createdAt: nowIso,
    });

    if (!isAsNeeded) {
      const newSched: Schedule = {
        id: uuidIdGenerator.generate(),
        medicineId: newMed.id,
        patientId: SINGLE_PATIENT_ID,
        frequencyType: 'daily',
        timesOfDay: [scheduledTime],
        dosageQuantity: 1,
        startDate: nowIso.slice(0, 10),
        active: true,
        updatedAt: nowIso,
        syncStatus: 'pending',
      };
      await androidDb.schedules.add(newSched);
      await androidDb.syncOutbox.add({
        table: 'schedules',
        entityId: newSched.id,
        action: 'CREATE',
        payload: newSched,
        createdAt: nowIso,
      });
    }

    // Reset
    setName('');
    setStrength('');
    setMinHours('');
    setMaxDoses('');
    setShowAddForm(false);
    await loadData();
  };

  return (
    <div className="flex flex-col gap-4 p-4 pb-24">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold tracking-tight text-slate-100">Medicines Protocol</h2>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className={m3ButtonPrimary}
        >
          {showAddForm ? 'Cancel' : '+ Add Medicine'}
        </button>
      </div>

      {showAddForm && (
        <M3Card className="border-sky-800/80 bg-slate-900/90">
          <h3 className="text-base font-bold text-slate-100">New Medicine Protocol</h3>

          <div className="flex flex-col gap-3 mt-2">
            <label className="text-xs font-semibold text-slate-400">Medicine Name:</label>
            <input
              type="text"
              placeholder="e.g., Ondansetron"
              className={m3InputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />

            <label className="text-xs font-semibold text-slate-400">Strength / Dosage:</label>
            <input
              type="text"
              placeholder="e.g., 4mg"
              className={m3InputClass}
              value={strength}
              onChange={(e) => setStrength(e.target.value)}
            />

            <div className="flex items-center gap-2 py-2">
              <input
                type="checkbox"
                id="asNeededCheck"
                checked={isAsNeeded}
                onChange={(e) => setIsAsNeeded(e.target.checked)}
                className="h-5 w-5 rounded border-slate-700 bg-slate-900 text-sky-600 focus:ring-sky-500"
              />
              <label htmlFor="asNeededCheck" className="text-sm font-semibold text-slate-200">
                As Needed (PRN)
              </label>
            </div>

            {isAsNeeded ? (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs font-semibold text-slate-400">Min Cooldown (Hours):</label>
                  <input
                    type="number"
                    placeholder="4"
                    className={m3InputClass}
                    value={minHoursBetweenDoses}
                    onChange={(e) => setMinHours(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-400">Max 24h Cap:</label>
                  <input
                    type="number"
                    placeholder="4"
                    className={m3InputClass}
                    value={maxDailyDoses}
                    onChange={(e) => setMaxDoses(e.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="text-xs font-semibold text-slate-400">Scheduled Time:</label>
                <input
                  type="time"
                  className={m3InputClass}
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                />
              </div>
            )}

            <button onClick={handleSaveMedicine} className={m3ButtonPrimary}>
              Save Medicine
            </button>
          </div>
        </M3Card>
      )}

      {/* Existing Medicines List */}
      {medicines.length === 0 ? (
        <M3Card>
          <p className="text-sm text-slate-400 text-center py-4">
            No medicines configured yet. Tap "+ Add Medicine" above.
          </p>
        </M3Card>
      ) : (
        medicines.map((med) => {
          const sched = schedules.find((s) => s.medicineId === med.id && s.active);
          return (
            <M3Card key={med.id}>
              <div className="flex items-center justify-between">
                <div className="flex flex-col">
                  <span className="text-base font-bold text-slate-100">{med.name}</span>
                  <span className="text-xs text-slate-400">{med.strength} • {med.form}</span>
                </div>
                <M3Badge tone={med.asNeeded ? 'info' : 'neutral'}>
                  {med.asNeeded ? 'PRN' : 'Scheduled'}
                </M3Badge>
              </div>

              <div className="text-xs text-slate-400 border-t border-slate-800/80 pt-2 flex flex-wrap gap-3">
                {med.minHoursBetweenDoses && <span>Min Gap: {med.minHoursBetweenDoses}h</span>}
                {med.maxDailyDoses && <span>Max Daily: {med.maxDailyDoses}</span>}
                {sched && <span>Daily Schedule: {sched.timesOfDay.join(', ')}</span>}
              </div>
            </M3Card>
          );
        })
      )}
    </div>
  );
}
