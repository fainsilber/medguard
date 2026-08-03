import { useLiveQuery } from 'dexie-react-hooks';
import type { ClockTrust } from '@medguard/shared';
import { useMedGuardDb } from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useTick } from '../../app/useTick.js';
import { Card } from '../../ui/primitives.js';
import { PrnCard } from './PrnCard.js';

/** Countdown re-render tick, shared by every card rather than one interval each — a live 1 hr
 * 14 min-style countdown across five medicines shouldn't cost five timers. */
const COUNTDOWN_TICK_MS = 1000;

/** PRD §2.3's PRN safety screen — one card per as-needed medicine. */
export function PrnScreen({ clockTrust }: { clockTrust?: ClockTrust }) {
  const db = useMedGuardDb();
  const householdSettings = useHouseholdSettings();

  useTick(COUNTDOWN_TICK_MS);

  // A PRN (as-needed) medicine is defined negatively: it's whatever doesn't have an active
  // schedule. Anything on a fixed schedule belongs on the Today view instead.
  const medicines = useLiveQuery(async () => {
    const [all, schedules] = await Promise.all([
      db.medicines.filter((medicine) => !medicine.archived).toArray(),
      db.schedules.toArray(),
    ]);
    const scheduledMedicineIds = new Set(
      schedules.filter((schedule) => schedule.active).map((schedule) => schedule.medicineId),
    );
    return all.filter((medicine) => !scheduledMedicineIds.has(medicine.id));
  }, [db]);
  const logs = useLiveQuery(() => db.intakeLogs.toArray(), [db]);

  if (!medicines || !logs || !householdSettings) {
    return (
      <Card>
        <p className="text-sm text-slate-400">Loading…</p>
      </Card>
    );
  }

  if (medicines.length === 0) {
    return (
      <Card>
        <p className="text-sm text-slate-400">No as-needed medicines are set up yet.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {medicines.map((medicine) => (
        <PrnCard
          key={medicine.id}
          medicine={medicine}
          logs={logs.filter((log) => log.medicineId === medicine.id)}
          timeZone={householdSettings.timeZone}
          {...(clockTrust !== undefined ? { clockTrust } : {})}
        />
      ))}
    </div>
  );
}
