import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import {
  addLocalDays,
  classifyOccurrence,
  effectiveLogs,
  expandSchedules,
  findLogForOccurrence,
  formatLocalDate,
  formatLocalTime,
  fromIso,
  occurrenceKey,
  resolveLocal,
  sortByActualTimeDesc,
} from '@medguard/shared';
import type { IntakeLog, Occurrence, OccurrenceStatus } from '@medguard/shared';
import {
  useClock,
  useCurrentDeviceId,
  useCurrentUserId,
  useIdGenerator,
  useMedGuardDb,
  useRepository,
} from '../../app/AndroidAppProvider.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useTick } from '../../app/useTick.js';
import {
  M3Badge,
  M3Card,
  m3ButtonPrimary,
  m3ButtonSecondary,
} from '../../ui/MaterialComponents.js';
import type { M3BadgeTone } from '../../ui/MaterialComponents.js';

/** Frequent enough that the overdue/due-now buckets feel live, cheap enough not to matter. */
const REFRESH_INTERVAL_MS = 30_000;

const STATUS_LABEL: Record<OccurrenceStatus, string> = {
  overdue: 'Overdue',
  due_now: 'Due now',
  upcoming: 'Upcoming',
  done: 'Taken',
  snoozed: 'Snoozed',
};

const STATUS_TONE: Record<OccurrenceStatus, M3BadgeTone> = {
  overdue: 'locked',
  due_now: 'info',
  upcoming: 'neutral',
  done: 'safe',
  snoozed: 'capped',
};

export function AndroidTodayView() {
  const db = useMedGuardDb();
  const repository = useRepository();
  const clock = useClock();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();
  const household = useHouseholdSettings();

  const [prompt, setPrompt] = useState<{ occurrence: Occurrence; medicineName: string } | null>(
    null,
  );

  // Re-renders on a timer so an occurrence crosses from upcoming to due-now to overdue on its
  // own. `nowMs` is still read from the injected clock, never ambiently.
  useTick(REFRESH_INTERVAL_MS);
  const nowMs = clock.nowMs();

  const medicines = useLiveQuery(() => db.medicines.toArray(), [db]);
  const schedules = useLiveQuery(() => db.schedules.toArray(), [db]);
  const logs = useLiveQuery(() => db.intakeLogs.toArray(), [db]);

  const timeZone = household?.timeZone;

  /**
   * Today's occurrences, in the *household* timezone rather than the device's (PRD §1).
   *
   * The range comes from resolving local midnight today and local midnight tomorrow, not from
   * slicing an ISO string, so a DST transition day is still exactly one day long — slicing would
   * make it 23 or 25 hours and drop or duplicate a dose.
   */
  const occurrences = useMemo<Occurrence[]>(() => {
    if (!timeZone || !schedules) {
      return [];
    }
    const today = formatLocalDate(timeZone, nowMs);
    const fromMs = resolveLocal(timeZone, today, '00:00').instantMs;
    const toMs = resolveLocal(timeZone, addLocalDays(today, 1), '00:00').instantMs;
    return expandSchedules(schedules, { fromMs, toMs }, timeZone);
  }, [schedules, timeZone, nowMs]);

  const medicineName = (medicineId: string) =>
    medicines?.find((medicine) => medicine.id === medicineId)?.name ?? 'Medicine';

  const recordScheduledDose = async (occurrence: Occurrence, actualTimeIso: string) => {
    const log: IntakeLog = {
      id: ids.next(),
      patientId: occurrence.patientId,
      medicineId: occurrence.medicineId,
      scheduleId: occurrence.scheduleId,
      type: 'scheduled',
      status: 'taken',
      scheduledTime: occurrence.dueAt,
      actualTime: actualTimeIso,
      quantityTaken: occurrence.dosageQuantity,
      loggedByUserId: userId,
      loggedByDeviceId: deviceId,
      syncStatus: 'pending',
    };

    await repository.recordDose(log);
    setPrompt(null);
  };

  if (!household) {
    return (
      <div className="flex flex-col gap-4 p-4 pb-28">
        <M3Card>
          <p className="py-4 text-center text-sm text-slate-400">Loading household settings…</p>
        </M3Card>
      </div>
    );
  }

  // Across every medicine, so the banner answers "what was the last thing given to this child?".
  // Superseded corrections are dropped first: showing a dose a caregiver has already corrected
  // as the most recent one is exactly the kind of stale reading that leads to a double dose.
  const effective = logs ? sortByActualTimeDesc(effectiveLogs(logs)) : [];
  const lastDose = effective.find((log) => log.status === 'taken');
  const recentLogs = effective.slice(0, 5);

  return (
    <div className="flex flex-col gap-4 p-4 pb-28">
      {lastDose && (
        <M3Card className="border-sky-800/50 bg-sky-950/30">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <span className="text-xs font-semibold uppercase tracking-wider text-sky-400">
                Last administered
              </span>
              <span className="text-base font-bold text-slate-100">
                {medicineName(lastDose.medicineId)}
              </span>
            </div>
            <M3Badge tone="info">
              {formatLocalTime(household.timeZone, fromIso(lastDose.actualTime))} by{' '}
              {lastDose.loggedByUserId}
            </M3Badge>
          </div>
        </M3Card>
      )}

      {prompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
          <div className="flex w-full max-w-sm flex-col gap-4 rounded-3xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-100">Log {prompt.medicineName}</h3>
            <p className="text-xs text-slate-400">
              Scheduled for {formatLocalTime(household.timeZone, fromIso(prompt.occurrence.dueAt))}.
              When was it actually given?
            </p>

            {/*
              Two explicit answers rather than one silent assumption. Recording "now" for a dose
              given two hours ago moves the next cooldown window by two hours, so which one the
              caregiver picks is a safety input, not a display detail.
            */}
            <button
              onClick={() => void recordScheduledDose(prompt.occurrence, prompt.occurrence.dueAt)}
              className={m3ButtonPrimary}
            >
              On time ({formatLocalTime(household.timeZone, fromIso(prompt.occurrence.dueAt))})
            </button>

            <button
              onClick={() => void recordScheduledDose(prompt.occurrence, clock.nowIso())}
              className={m3ButtonSecondary}
            >
              Just now
            </button>

            <button
              onClick={() => setPrompt(null)}
              className="mt-1 text-xs font-semibold text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <h2 className="text-lg font-bold tracking-tight text-slate-100">Today&rsquo;s schedule</h2>

      {occurrences.length === 0 ? (
        <M3Card>
          <p className="py-4 text-center text-sm text-slate-400">No scheduled doses for today.</p>
        </M3Card>
      ) : (
        occurrences.map((occurrence) => {
          const log = logs ? findLogForOccurrence(logs, occurrence) : undefined;
          const status = classifyOccurrence(occurrence.dueAt, nowMs, log !== undefined);

          return (
            <M3Card key={occurrenceKey(occurrence)}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-base font-bold text-slate-100">
                    {medicineName(occurrence.medicineId)}
                  </span>
                  <span className="text-xs text-slate-400">
                    {formatLocalTime(household.timeZone, fromIso(occurrence.dueAt))}
                    {occurrence.dstAdjustment ? ' • DST adjusted' : ''}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <M3Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</M3Badge>
                  {status !== 'done' && (
                    <button
                      onClick={() =>
                        setPrompt({
                          occurrence,
                          medicineName: medicineName(occurrence.medicineId),
                        })
                      }
                      className={m3ButtonPrimary}
                    >
                      Mark taken
                    </button>
                  )}
                </div>
              </div>
            </M3Card>
          );
        })
      )}

      <h2 className="mt-4 text-lg font-bold tracking-tight text-slate-100">Recent history</h2>
      {recentLogs.length === 0 ? (
        <M3Card>
          <p className="py-4 text-center text-sm text-slate-400">Nothing logged yet.</p>
        </M3Card>
      ) : (
        recentLogs.map((log) => (
          <M3Card key={log.id} className="py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-sm font-semibold text-slate-200">
                  {medicineName(log.medicineId)}
                </span>
                <span className="text-xs text-slate-400">Logged by {log.loggedByUserId}</span>
              </div>
              <span className="font-mono text-xs text-slate-400">
                {formatLocalTime(household.timeZone, fromIso(log.actualTime))}
              </span>
            </div>
          </M3Card>
        ))
      )}
    </div>
  );
}
