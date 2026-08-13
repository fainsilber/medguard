import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import {
  SINGLE_PATIENT_ID,
  assessDose,
  blockReasonFor,
  clockAt,
  collectReconciliationItems,
  formatLocalDate,
  formatLocalTime,
  fromIso,
  resolveLocal,
  toIso,
} from '@medguard/shared';
import type { BlockReason, IntakeLog, ReconciliationItem } from '@medguard/shared';
import type { ReconciliationEntry } from '@medguard/store';
import {
  useClock,
  useCurrentDeviceId,
  useCurrentUserId,
  useIdGenerator,
  useMedGuardDb,
  useRepository,
} from '../../app/RepositoryContext.js';
import { useHouseholdSettings } from '../../app/useHouseholdSettings.js';
import { getLocalClockTrust } from '../../clock/localClockGuard.js';
import {
  Card,
  buttonClass,
  inputClass,
  labelClass,
  primaryButtonClass,
} from '../../ui/primitives.js';

/**
 * The Motzei Shabbat reconciliation sheet (PRD §3, Sprint A5 phase 2).
 *
 * During Shabbat nothing may be written, so the app records only that an alert fired. This is
 * where a caregiver says what actually happened — the other half of that deferral, and the only
 * thing that makes deferring honest rather than lossy.
 *
 * Two shapes of question, deliberately separate:
 *
 *   - **Scheduled doses**, listed from the window itself rather than from the placeholder logs, so
 *     a dose whose alert never fired is still asked about.
 *   - **PRN doses**, which have no scheduled occurrence to reconcile and are therefore entered
 *     rather than confirmed — with the guard judged as of when the dose was given, not now.
 *
 * Stock catches up as a consequence: every confirmed dose mints its own ledger entry through the
 * ordinary path, so the inventory reconciliation the sprint plan asks for is not a separate
 * mechanism, only a visible one.
 */

type Answer = 'given' | 'not_given';

interface RowState {
  answer: Answer;
  /** Wall-clock `HH:MM` in the household's zone. Defaults to when the dose was due. */
  time: string;
  quantity: string;
}

function defaultRowState(item: ReconciliationItem, timeZone: string): RowState {
  return {
    answer: 'given',
    time: formatLocalTime(timeZone, fromIso(item.occurrence.dueAt)),
    quantity: String(item.occurrence.dosageQuantity),
  };
}

export function ReconciliationSheet({ onDone }: { onDone?: () => void }) {
  const db = useMedGuardDb();
  const repository = useRepository();
  const clock = useClock();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();
  const householdSettings = useHouseholdSettings();

  const windows = useLiveQuery(() => db.shabbatWindows.toArray(), [db]);
  const schedules = useLiveQuery(() => db.schedules.toArray(), [db]);
  const medicines = useLiveQuery(() => db.medicines.toArray(), [db]);
  const logs = useLiveQuery(() => db.intakeLogs.toArray(), [db]);

  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timeZone = householdSettings?.timeZone;
  const nowMs = clock.nowMs();

  const items = useMemo(() => {
    if (!windows || !schedules || !medicines || !logs || !timeZone) {
      return undefined;
    }
    return collectReconciliationItems({
      windows,
      schedules,
      medicines,
      logs,
      timeZone,
      nowMs,
    });
  }, [windows, schedules, medicines, logs, timeZone, nowMs]);

  const rowFor = (item: ReconciliationItem): RowState =>
    rows[item.key] ?? defaultRowState(item, timeZone ?? 'UTC');

  const setRow = (item: ReconciliationItem, changes: Partial<RowState>) => {
    setRows((current) => ({
      ...current,
      [item.key]: { ...(current[item.key] ?? defaultRowState(item, timeZone ?? 'UTC')), ...changes },
    }));
  };

  const buildEntry = (item: ReconciliationItem, state: RowState): ReconciliationEntry => {
    // Resolved against the day the dose was *due*, not today: reconciliation happens after
    // Havdalah, which is a different calendar day from the Friday-night dose being answered.
    const dueMs = fromIso(item.occurrence.dueAt);
    const resolved = resolveLocal(
      timeZone ?? 'UTC',
      formatLocalDate(timeZone ?? 'UTC', dueMs),
      state.time,
    );
    const given = state.answer === 'given';

    const log: Omit<IntakeLog, 'supersedesId'> = {
      id: ids.next(),
      patientId: item.occurrence.patientId,
      medicineId: item.occurrence.medicineId,
      scheduleId: item.occurrence.scheduleId,
      type: 'scheduled',
      status: given ? 'taken' : 'skipped',
      scheduledTime: item.occurrence.dueAt,
      actualTime: given ? toIso(resolved.instantMs) : item.occurrence.dueAt,
      quantityTaken: given ? Number(state.quantity) : 0,
      loggedByUserId: userId,
      loggedByDeviceId: deviceId,
      syncStatus: 'pending',
    };

    return {
      log,
      ...(item.pendingLog ? { supersedesLogId: item.pendingLog.id } : {}),
    };
  };

  const submit = async (entries: ReconciliationEntry[]) => {
    if (entries.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      await repository.reconcileShabbatDoses(entries);
      setRows({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const confirmAll = () => {
    if (!items) return;
    void submit(items.map((item) => buildEntry(item, defaultRowState(item, timeZone ?? 'UTC'))));
  };

  const saveAnswers = () => {
    if (!items) return;
    void submit(items.map((item) => buildEntry(item, rowFor(item))));
  };

  if (!items || !timeZone || !medicines) {
    return (
      <Card>
        <p className="text-sm text-slate-400">Loading…</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <h2 className="text-lg font-semibold">Shabbat is over</h2>
        {items.length === 0 ? (
          <p className="text-sm text-slate-400">
            Every dose from Shabbat has been accounted for. Nothing left to record.
          </p>
        ) : (
          <>
            <p className="text-sm text-slate-400">
              {items.length === 1
                ? 'One scheduled dose from Shabbat has not been recorded yet.'
                : `${items.length} scheduled doses from Shabbat have not been recorded yet.`}{' '}
              Confirming them updates the medical record and the stock counts, which have both been
              waiting since candle lighting.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={primaryButtonClass}
                disabled={saving}
                onClick={confirmAll}
              >
                {saving ? 'Recording…' : 'All given as scheduled'}
              </button>
              {onDone && (
                <button type="button" className={buttonClass} disabled={saving} onClick={onDone}>
                  Later
                </button>
              )}
            </div>
          </>
        )}
        {error && <p className="text-sm text-locked">{error}</p>}
      </Card>

      {items.length > 0 && (
        <Card>
          <h3 className="text-sm font-semibold">Or answer them one at a time</h3>
          <ul className="flex flex-col gap-3">
            {items.map((item) => {
              const state = rowFor(item);
              return (
                <li
                  key={item.key}
                  className="flex flex-col gap-2 rounded-md border border-slate-800 p-3 text-sm"
                >
                  <div>
                    <p className="font-medium">{item.medicineName}</p>
                    <p className="text-slate-400">
                      Due {formatLocalDate(timeZone, fromIso(item.occurrence.dueAt))} ·{' '}
                      {item.occurrence.scheduledLocalTime} · {item.occurrence.dosageQuantity}
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={state.answer === 'given' ? primaryButtonClass : buttonClass}
                      aria-pressed={state.answer === 'given'}
                      onClick={() => setRow(item, { answer: 'given' })}
                    >
                      Given
                    </button>
                    <button
                      type="button"
                      className={state.answer === 'not_given' ? primaryButtonClass : buttonClass}
                      aria-pressed={state.answer === 'not_given'}
                      onClick={() => setRow(item, { answer: 'not_given' })}
                    >
                      Not given
                    </button>
                  </div>

                  {state.answer === 'given' && (
                    <div className="flex flex-wrap gap-3">
                      <label className={labelClass}>
                        Time given
                        <input
                          className={inputClass}
                          type="time"
                          value={state.time}
                          onChange={(event) => setRow(item, { time: event.target.value })}
                          aria-label={`Time given — ${item.medicineName}`}
                        />
                      </label>
                      <label className={labelClass}>
                        Quantity
                        <input
                          className={inputClass}
                          type="number"
                          min={0}
                          step="0.5"
                          value={state.quantity}
                          onChange={(event) => setRow(item, { quantity: event.target.value })}
                          aria-label={`Quantity — ${item.medicineName}`}
                        />
                      </label>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            className={primaryButtonClass}
            disabled={saving}
            onClick={saveAnswers}
          >
            {saving ? 'Recording…' : 'Record these answers'}
          </button>
        </Card>
      )}

      <RetroactivePrn timeZone={timeZone} />
    </div>
  );
}

/**
 * Entering an as-needed dose given during Shabbat.
 *
 * The guard is assessed **as of the moment the dose was given** (`clockAt`), not as of now — the
 * question is whether that dose was within the cooldown when it happened, which is also exactly
 * what the Durable Object re-checks on push. When it binds, the same double-confirm and written
 * reason the PRN screen demands: the dose already happened, so the record always takes it, but
 * never silently (safety invariant 5).
 */
function RetroactivePrn({ timeZone }: { timeZone: string }) {
  const db = useMedGuardDb();
  const repository = useRepository();
  const clock = useClock();
  const ids = useIdGenerator();
  const userId = useCurrentUserId();
  const deviceId = useCurrentDeviceId();

  const medicines = useLiveQuery(
    () => db.medicines.filter((medicine) => medicine.asNeeded && !medicine.archived).toArray(),
    [db],
  );
  const logs = useLiveQuery(() => db.intakeLogs.toArray(), [db]);

  const [medicineId, setMedicineId] = useState('');
  const [date, setDate] = useState(formatLocalDate(timeZone, clock.nowMs()));
  const [time, setTime] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState('');
  const [blockedBy, setBlockedBy] = useState<BlockReason | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);

  if (!medicines || medicines.length === 0 || !logs) {
    return null;
  }

  const reset = () => {
    setMedicineId('');
    setTime('');
    setQuantity('1');
    setReason('');
    setBlockedBy(null);
  };

  const record = async (override?: { reason: string; blockedBy: BlockReason }) => {
    const medicine = medicines.find((candidate) => candidate.id === medicineId);
    if (!medicine || !time) {
      setError('Choose a medicine and the time it was given.');
      return;
    }

    const resolved = resolveLocal(timeZone, date, time);
    const givenAtMs = resolved.instantMs;

    if (!override) {
      const safety = assessDose({
        medicine,
        logs,
        // The instant the dose was given, not the instant it is being typed in.
        clock: clockAt(givenAtMs),
        clockTrust: getLocalClockTrust(),
      });
      const blocked = blockReasonFor(safety);
      if (blocked) {
        setBlockedBy(blocked);
        return;
      }
    }

    setSaving(true);
    setError(null);
    try {
      await repository.recordDose({
        id: ids.next(),
        patientId: SINGLE_PATIENT_ID,
        medicineId: medicine.id,
        type: 'prn',
        status: 'taken',
        actualTime: toIso(givenAtMs),
        quantityTaken: Number(quantity),
        loggedByUserId: userId,
        loggedByDeviceId: deviceId,
        syncStatus: 'pending',
        ...(override
          ? {
              override: {
                confirmedByUserId: userId,
                reason: override.reason,
                blockedBy: override.blockedBy,
              },
            }
          : {}),
      });
      setRecorded(`${medicine.name} at ${time}`);
      reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <h3 className="text-sm font-semibold">Something given as needed during Shabbat?</h3>
      <p className="text-sm text-slate-400">
        As-needed doses have no scheduled time to confirm, so they are entered here rather than
        listed above.
      </p>

      <label className={labelClass}>
        Medicine
        <select
          className={inputClass}
          value={medicineId}
          onChange={(event) => {
            setMedicineId(event.target.value);
            setBlockedBy(null);
          }}
          aria-label="Medicine given as needed"
        >
          <option value="">Choose…</option>
          {medicines.map((medicine) => (
            <option key={medicine.id} value={medicine.id}>
              {medicine.name} {medicine.strength}
            </option>
          ))}
        </select>
      </label>

      <div className="flex flex-wrap gap-3">
        <label className={labelClass}>
          Date given
          <input
            className={inputClass}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            aria-label="Date given"
          />
        </label>
        <label className={labelClass}>
          Time given
          <input
            className={inputClass}
            type="time"
            value={time}
            onChange={(event) => {
              setTime(event.target.value);
              setBlockedBy(null);
            }}
            aria-label="Time given as needed"
          />
        </label>
        <label className={labelClass}>
          Quantity
          <input
            className={inputClass}
            type="number"
            min={0}
            step="0.5"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            aria-label="Quantity given as needed"
          />
        </label>
      </div>

      {blockedBy && (
        <div className="flex flex-col gap-2 rounded-md border border-locked p-3">
          <p className="text-sm">
            At that time this dose was inside the safety limit for this medicine. It still
            happened, so it still gets recorded — say why, and the reason is kept with it.
          </p>
          <label className={labelClass}>
            What happened
            <input
              className={inputClass}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              aria-label="Why this dose was given"
            />
          </label>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={saving || reason.trim().length === 0}
            onClick={() => void record({ reason: reason.trim(), blockedBy })}
          >
            Record it with this reason
          </button>
        </div>
      )}

      {!blockedBy && (
        <button
          type="button"
          className={buttonClass}
          disabled={saving || !medicineId || !time}
          onClick={() => void record()}
        >
          {saving ? 'Recording…' : 'Record this dose'}
        </button>
      )}

      {recorded && <p className="text-sm text-safe">Recorded: {recorded}</p>}
      {error && <p className="text-sm text-locked">{error}</p>}
    </Card>
  );
}
