import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import {
  expandSchedules,
  findLogForOccurrence,
  formatLocalDate,
  formatLocalTime,
  fromIso,
  occurrenceKey,
} from '@medguard/shared';
import type { IntakeLog, Occurrence } from '@medguard/shared';
import {
  useClock,
  useCurrentDeviceId,
  useCurrentUserId,
  useIdGenerator,
  useMedGuardDb,
  useRepository,
} from '../../app/AndroidAppProvider.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { ShabbatChimeEngine } from '../../native/androidBridge.js';
import {
  M3Badge,
  M3Card,
  m3ButtonPrimary,
  m3ButtonSecondary,
} from '../../ui/MaterialComponents.js';

/** Long enough to span Shabbat and a two-day chag with room either side. */
const RECONCILE_WINDOW_HOURS = 72;

const TEST_CHIME_SECONDS = 15;

export function AndroidShabbatScreen() {
  const db = useMedGuardDb();
  const repository = useRepository();
  const clock = useClock();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();
  const household = useHouseholdSettings();

  const [chime] = useState(() => new ShabbatChimeEngine());
  const [chiming, setChiming] = useState(false);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [reconciledCount, setReconciledCount] = useState<number | null>(null);

  // A chime left running when the caregiver navigates away would keep sounding with nothing on
  // screen to stop it.
  useEffect(() => () => chime.stop(), [chime]);

  const medicines = useLiveQuery(() => db.medicines.toArray(), [db]);
  const schedules = useLiveQuery(() => db.schedules.toArray(), [db]);
  const logs = useLiveQuery(() => db.intakeLogs.toArray(), [db]);

  const nowMs = clock.nowMs();
  const timeZone = household?.timeZone;

  /**
   * Doses that came due over the reconciliation window and have no log yet.
   *
   * Reconciling by *occurrence* rather than by medicine is what makes the result usable
   * afterwards: a log carries `scheduledTime`, and the Today view matches a log to its
   * occurrence on `(scheduleId, scheduledTime)`. A log written without one leaves the occurrence
   * showing as never given, which is exactly the confusion Motzei Shabbat reconciliation exists
   * to clear up.
   */
  const outstanding = useMemo<Occurrence[]>(() => {
    if (!timeZone || !schedules || !logs) {
      return [];
    }
    const fromMs = nowMs - RECONCILE_WINDOW_HOURS * 3_600_000;
    return expandSchedules(schedules, { fromMs, toMs: nowMs }, timeZone).filter(
      (occurrence) => findLogForOccurrence(logs, occurrence) === undefined,
    );
  }, [schedules, logs, timeZone, nowMs]);

  const medicineName = (medicineId: string) =>
    medicines?.find((medicine) => medicine.id === medicineId)?.name ?? 'Medicine';

  const toggleChime = () => {
    if (chiming) {
      chime.stop();
      setChiming(false);
      return;
    }
    // The engine reports whether it actually started, so the button never claims a chime that a
    // still-running one refused.
    setChiming(chime.start(TEST_CHIME_SECONDS, () => setChiming(false)));
  };

  const reconcile = async () => {
    const chosen = outstanding.filter((occurrence) => selected.includes(occurrenceKey(occurrence)));

    for (const occurrence of chosen) {
      const log: IntakeLog = {
        id: ids.next(),
        patientId: occurrence.patientId,
        medicineId: occurrence.medicineId,
        scheduleId: occurrence.scheduleId,
        type: 'scheduled',
        status: 'taken',
        scheduledTime: occurrence.dueAt,
        // Recorded at its due time rather than at reconciliation time: the dose was given over
        // Shabbat, and stamping it "now" would push every subsequent cooldown window hours late.
        actualTime: occurrence.dueAt,
        quantityTaken: occurrence.dosageQuantity,
        loggedByUserId: userId,
        loggedByDeviceId: deviceId,
        notes: 'Motzei Shabbat reconciliation',
        syncStatus: 'pending',
      };
      await repository.recordDose(log);
    }

    setReconciledCount(chosen.length);
    setSelected([]);
  };

  return (
    <div className="flex flex-col gap-4 p-4 pb-28">
      <div className="flex flex-col">
        <h2 className="text-xl font-bold tracking-tight text-slate-100">Shabbat &amp; Yom Tov</h2>
        <p className="text-xs text-slate-400">
          Foreground chime and Motzei Shabbat reconciliation.
        </p>
      </div>

      <M3Card className="border-sky-800 bg-sky-950/20">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col">
            <span className="text-base font-bold text-slate-100">Chime engine</span>
            {/*
              Stated plainly rather than implied. The PRD's 45-second chime on a *locked* phone
              needs a native foreground service on the alarm stream; a WebView is suspended when
              backgrounded, so what this button demonstrates is the foreground approximation.
            */}
            <span className="text-xs text-slate-400">
              Foreground only — a locked-screen chime needs the native alarm service.
            </span>
          </div>

          <button onClick={toggleChime} className={chiming ? m3ButtonSecondary : m3ButtonPrimary}>
            {chiming ? 'Stop chime' : `Test ${TEST_CHIME_SECONDS}s chime`}
          </button>
        </div>
      </M3Card>

      <div className="mt-4 flex flex-col gap-2">
        <h3 className="text-lg font-bold text-slate-100">Motzei Shabbat reconciliation</h3>
        <p className="text-xs text-slate-400">
          Doses that came due in the last {RECONCILE_WINDOW_HOURS} hours with nothing logged against
          them. Select the ones that were given.
        </p>

        {reconciledCount !== null && (
          <M3Card className="border-emerald-600/60 bg-emerald-950/60">
            <p className="text-sm font-semibold text-emerald-300">
              {reconciledCount} dose{reconciledCount === 1 ? '' : 's'} recorded and queued to sync.
            </p>
          </M3Card>
        )}

        {outstanding.length === 0 ? (
          <M3Card>
            <p className="py-4 text-center text-sm text-slate-400">Nothing outstanding.</p>
          </M3Card>
        ) : (
          outstanding.map((occurrence) => {
            const key = occurrenceKey(occurrence);
            const isSelected = selected.includes(key);

            return (
              <M3Card
                key={key}
                onClick={() =>
                  setSelected(
                    isSelected
                      ? selected.filter((candidate) => candidate !== key)
                      : [...selected, key],
                  )
                }
                className={isSelected ? 'border-sky-500 bg-sky-950/40' : ''}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col">
                    <span className="text-base font-bold text-slate-100">
                      {medicineName(occurrence.medicineId)}
                    </span>
                    <span className="text-xs text-slate-400">
                      {timeZone
                        ? `${formatLocalDate(timeZone, fromIso(occurrence.dueAt))} ${formatLocalTime(
                            timeZone,
                            fromIso(occurrence.dueAt),
                          )}`
                        : occurrence.dueAt}
                    </span>
                  </div>
                  <M3Badge tone={isSelected ? 'safe' : 'neutral'}>
                    {isSelected ? 'Selected' : 'Tap to select'}
                  </M3Badge>
                </div>
              </M3Card>
            );
          })
        )}

        {selected.length > 0 && (
          <button onClick={() => void reconcile()} className={`${m3ButtonPrimary} mt-2`}>
            Confirm {selected.length} dose{selected.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
    </div>
  );
}
