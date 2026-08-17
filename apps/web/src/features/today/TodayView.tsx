import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import {
  addLocalDays,
  classifyOccurrence,
  expandSchedules,
  findLogForOccurrence,
  formatLocalDate,
  formatLocalTime,
  fromIso,
  occurrenceKey,
  resolveLocal,
} from '@medguard/shared';
import type { Occurrence, OccurrenceStatus } from '@medguard/shared';
import { usePatients } from '../../app/PatientProvider.js';
import {
  useClock,
  useCurrentDeviceId,
  useCurrentUserId,
  useIdGenerator,
  useMedGuardDb,
  useRepository,
} from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { useTick } from '../../app/useTick.js';
import { DoseCorrection } from '../logs/DoseCorrection.js';
import { Badge, Card, buttonClass, primaryButtonClass } from '../../ui/primitives.js';
import { TakenTimePrompt } from './TakenTimePrompt.js';

const SNOOZE_MINUTES = 15;
/** Frequent enough that overdue/due-now buckets feel live, cheap enough not to matter. */
const REFRESH_INTERVAL_MS = 30_000;

const STATUS_LABEL: Record<OccurrenceStatus, string> = {
  overdue: 'Overdue',
  due_now: 'Due now',
  snoozed: 'Snoozed',
  upcoming: 'Upcoming',
  pending_shabbat: 'Awaiting Shabbat reconciliation',
  done: 'Done',
};

/** Colours the section heading itself rather than a separate per-row badge, which would just
 * repeat text already on screen — a caregiver already knows what section they're looking at. */
const STATUS_HEADING_CLASS: Record<OccurrenceStatus, string> = {
  overdue: 'text-locked',
  due_now: 'text-capped',
  snoozed: 'text-slate-500',
  upcoming: 'text-slate-500',
  pending_shabbat: 'text-capped',
  done: 'text-safe',
};

/** Doses due today, PRD §2's "Today view (overdue, due now, upcoming, done)". */
export function TodayView() {
  const db = useMedGuardDb();
  const repository = useRepository();
  const clock = useClock();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();
  const householdSettings = useHouseholdSettings();
  const { patients, filterPatientId } = usePatients();
  const [snoozedUntil, setSnoozedUntil] = useState<Map<string, number>>(new Map());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [promptingKey, setPromptingKey] = useState<string | null>(null);

  useTick(REFRESH_INTERVAL_MS);

  const allSchedules = useLiveQuery(() => db.schedules.toArray(), [db]);
  const logs = useLiveQuery(() => db.intakeLogs.toArray(), [db]);

  // "All patients" mode shows every schedule with a name badge per row (below); a specific
  // selection narrows to that patient's own schedules — `Schedule.patientId` is not vestigial the
  // way `Medicine.patientId` is, so this needs no join through medicinePatients.
  const schedules = useMemo(
    () =>
      allSchedules === undefined || filterPatientId === undefined
        ? allSchedules
        : allSchedules.filter((schedule) => schedule.patientId === filterPatientId),
    [allSchedules, filterPatientId],
  );

  const patientNames = useMemo(
    () => new Map(patients.map((patient) => [patient.id, patient.displayName])),
    [patients],
  );
  const showPatientBadges = filterPatientId === undefined && patients.length > 1;

  const nowMs = clock.nowMs();
  const timeZone = householdSettings?.timeZone;
  const today = timeZone ? formatLocalDate(timeZone, nowMs) : undefined;

  const rows = useMemo(() => {
    if (!schedules || !logs || !timeZone || !today) {
      return undefined;
    }

    const tomorrow = addLocalDays(today, 1);
    const range = {
      fromMs: resolveLocal(timeZone, today, '00:00').instantMs,
      toMs: resolveLocal(timeZone, tomorrow, '00:00').instantMs,
    };

    return expandSchedules(schedules, range, timeZone).map((occurrence) => {
      const key = occurrenceKey(occurrence);
      const log = findLogForOccurrence(logs, occurrence);
      const status = classifyOccurrence(occurrence.dueAt, nowMs, log?.status, snoozedUntil.get(key));
      return { occurrence, log, status, key };
    });
  }, [schedules, logs, timeZone, today, nowMs, snoozedUntil]);

  const medicineNames = useLiveQuery(async () => {
    const medicines = await db.medicines.toArray();
    return new Map(medicines.map((medicine) => [medicine.id, `${medicine.name} ${medicine.strength}`]));
  }, [db]);

  const handleTaken = async (occurrence: Occurrence, key: string, actualTimeIso?: string) => {
    setBusyKey(key);
    try {
      await repository.recordDose({
        id: ids.next(),
        patientId: occurrence.patientId,
        medicineId: occurrence.medicineId,
        scheduleId: occurrence.scheduleId,
        type: 'scheduled',
        status: 'taken',
        scheduledTime: occurrence.dueAt,
        actualTime: actualTimeIso ?? clock.nowIso(),
        quantityTaken: occurrence.dosageQuantity,
        loggedByUserId: userId,
        loggedByDeviceId: deviceId,
        syncStatus: 'pending',
      });
      setPromptingKey(null);
    } finally {
      setBusyKey(null);
    }
  };

  /**
   * An overdue dose is the one case where "when was this taken?" has a real answer other than
   * "now" — so it asks. Anything else logs straight away, because friction on the common path is
   * what makes a caregiver stop logging at all.
   */
  const handleTakenClick = (occurrence: Occurrence, key: string, status: OccurrenceStatus) => {
    if (status === 'overdue') {
      setPromptingKey(key);
      return;
    }
    void handleTaken(occurrence, key);
  };

  const handleSkipped = async (occurrence: Occurrence, key: string) => {
    setBusyKey(key);
    try {
      await repository.recordDose({
        id: ids.next(),
        patientId: occurrence.patientId,
        medicineId: occurrence.medicineId,
        scheduleId: occurrence.scheduleId,
        type: 'scheduled',
        status: 'skipped',
        scheduledTime: occurrence.dueAt,
        actualTime: clock.nowIso(),
        quantityTaken: 0,
        loggedByUserId: userId,
        loggedByDeviceId: deviceId,
        syncStatus: 'pending',
      });
    } finally {
      setBusyKey(null);
    }
  };

  /**
   * Local display state only, not persisted (Sprint 2 has no alarm engine to re-ring in 15
   * minutes — that's Sprint 5). This just moves the occurrence out of the urgent buckets for a
   * while; reloading the page clears it.
   */
  const handleSnooze = (key: string) => {
    setSnoozedUntil((current) => {
      const next = new Map(current);
      next.set(key, nowMs + SNOOZE_MINUTES * 60_000);
      return next;
    });
  };

  if (!rows || !medicineNames) {
    return (
      <Card>
        <p className="text-sm text-slate-400">Loading…</p>
      </Card>
    );
  }

  // `pending_shabbat` sits above `done` rather than beside it: those doses still owe an answer,
  // and after Havdalah they are the first thing a caregiver has to deal with.
  const sections: OccurrenceStatus[] = [
    'overdue',
    'due_now',
    'snoozed',
    'upcoming',
    'pending_shabbat',
    'done',
  ];

  return (
    <Card>
      <h2 className="text-lg font-semibold">Today</h2>
      {rows.length === 0 && <p className="text-sm text-slate-400">Nothing scheduled today.</p>}

      {sections.map((status) => {
        const inSection = rows.filter((row) => row.status === status);
        if (inSection.length === 0) return null;

        return (
          <section key={status} className="flex flex-col gap-2">
            <h3 className={`text-xs font-semibold uppercase tracking-wide ${STATUS_HEADING_CLASS[status]}`}>
              {STATUS_LABEL[status]}
            </h3>
            <ul className="flex flex-col gap-2">
              {inSection.map(({ occurrence, log, key }) => (
                <li
                  key={key}
                  className="flex flex-col gap-3 rounded-md border border-slate-800 p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">
                        {medicineNames.get(occurrence.medicineId) ?? 'Unknown medicine'}
                        {showPatientBadges && (
                          <Badge tone="neutral">
                            {patientNames.get(occurrence.patientId) ?? 'Unknown patient'}
                          </Badge>
                        )}
                      </p>
                      <p className="text-slate-400">
                        Due {formatLocalTime(timeZone!, fromIso(occurrence.dueAt))} ·{' '}
                        {occurrence.dosageQuantity}
                      </p>
                      {log && (
                        <>
                          <p className="text-xs text-slate-500">
                            {log.status === 'taken'
                              ? `Taken ${formatLocalTime(timeZone!, fromIso(log.actualTime))}`
                              : 'Skipped'}{' '}
                            by {log.loggedByUserId}
                            {log.status === 'taken' &&
                              log.actualTime !== occurrence.dueAt &&
                              ' · not at the scheduled time'}
                          </p>
                          <DoseCorrection allLogs={logs ?? []} tipLog={log} timeZone={timeZone!} />
                        </>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {status !== 'done' && promptingKey !== key && (
                        <>
                          <button
                            type="button"
                            className={primaryButtonClass}
                            disabled={busyKey === key}
                            onClick={() => handleTakenClick(occurrence, key, status)}
                          >
                            Taken
                          </button>
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={busyKey === key}
                            onClick={() => void handleSkipped(occurrence, key)}
                          >
                            Skip
                          </button>
                          {status !== 'snoozed' && (
                            <button
                              type="button"
                              className={buttonClass}
                              disabled={busyKey === key}
                              onClick={() => handleSnooze(key)}
                            >
                              Snooze 15m
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {promptingKey === key && (
                    <TakenTimePrompt
                      dueAtIso={occurrence.dueAt}
                      nowMs={nowMs}
                      timeZone={timeZone!}
                      saving={busyKey === key}
                      onConfirm={(actualTimeIso) => void handleTaken(occurrence, key, actualTimeIso)}
                      onCancel={() => setPromptingKey(null)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </Card>
  );
}
