import {
  DEFAULT_ESCALATION_MINUTES,
  DEFAULT_SNOOZE_MINUTES,
  MISSED_AFTER_MINUTES,
  MS_PER_MINUTE,
  PUSH_PAYLOAD_VERSION,
  deriveInventoryState,
  deriveSnoozeState,
  expandSchedules,
  findLogForOccurrence,
  fromIso,
  occurrenceKey,
  toIso,
  uuidIdGenerator,
} from '@medguard/shared';
import type {
  DosePushPayload,
  DoseSnooze,
  HouseholdSettings,
  IntakeLog,
  InventoryAdjustment,
  InventoryItem,
  Medicine,
  Occurrence,
  Schedule,
} from '@medguard/shared';
import { dispatchToHousehold } from '../push/dispatch.js';
import { applyRecord } from '../sync/repository.js';

/**
 * The server half of the alarm system (Sprint A4).
 *
 * Split out of `HouseholdDO` because it is the largest single behaviour the Durable Object has,
 * and because the DO's other job — serializing authoritative safety re-checks — is unrelated to
 * it. The DO owns one of these and hands it its own SQLite storage.
 *
 * **What this is for.** The device's local alarm is primary: only it works with no signal, and
 * only it can play the PRD's 45-second chime. This chain is the backstop, and it exists for two
 * things the phone structurally cannot do:
 *
 *   1. **Escalation.** A phone cannot know whether *another* caregiver acknowledged a dose. A
 *      Durable Object is single-threaded per household, so it can.
 *   2. **An unarmed device.** Permission denied, notifications off, battery manager, phone off,
 *      app uninstalled. Nothing local fires; the push still arrives.
 *
 * The server deliberately does **not** try to suppress its own push when it thinks the device's
 * local alarm already fired. It cannot know whether it did — and for a medication alarm, one
 * redundant notification is the correct direction to fail (safety invariant 3). Both clients tag
 * the notification with the `occurrenceKey`, so a late push *replaces* the local one instead of
 * stacking a second alert next to it.
 */

/** How far ahead occurrences are materialized. Matches the device's own window in `horizon.ts`. */
const HORIZON_MS = 48 * 60 * 60 * 1000;

/**
 * How much work one alarm wake may do.
 *
 * A DO alarm can fire long after its due time (or after a household has been idle for days), so
 * several items can be owed at once. Bounded so one wake cannot turn into an unbounded run of
 * pushes; the chain simply re-arms for the rest.
 */
const MAX_WORK_PER_WAKE = 20;

/** `pending → notified → escalated`, and out via `acknowledged` or `missed`. */
type AlarmState = 'pending' | 'notified' | 'escalated' | 'acknowledged' | 'missed';

interface DoseAlarmRow extends Record<string, SqlStorageValue> {
  occurrence_id: string;
  schedule_id: string;
  medicine_id: string;
  patient_id: string;
  medicine_name: string;
  dosage_quantity: number;
  due_at_ms: number;
  /** When the dose alert is owed — the due time, or a snooze's deadline once one is granted. */
  notify_at_ms: number;
  escalate_at_ms: number;
  /** Anchored to the due time and never moved by a snooze: 180 minutes late is late. */
  missed_at_ms: number;
  state: AlarmState;
  snooze_count: number;
  fired_at_ms: number | null;
}

export function createAlarmTables(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS alarm_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dose_alarms (
      occurrence_id   TEXT PRIMARY KEY,
      schedule_id     TEXT NOT NULL,
      medicine_id     TEXT NOT NULL,
      patient_id      TEXT NOT NULL,
      medicine_name   TEXT NOT NULL,
      dosage_quantity REAL NOT NULL,
      due_at_ms       INTEGER NOT NULL,
      notify_at_ms    INTEGER NOT NULL,
      escalate_at_ms  INTEGER NOT NULL,
      missed_at_ms    INTEGER NOT NULL,
      state           TEXT NOT NULL,
      snooze_count    INTEGER NOT NULL DEFAULT 0,
      fired_at_ms     INTEGER,
      -- Mark-and-sweep marker: set on every row a materialization pass still produces, so the
      -- pass can delete whatever it no longer produces. Without it a schedule moved from 08:00 to
      -- 09:00 would keep firing at 08:00 forever, because re-materializing only ever adds.
      seen_at_ms      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dose_alarms_state ON dose_alarms(state, notify_at_ms);
    CREATE TABLE IF NOT EXISTS low_stock_flags (
      medicine_id   TEXT PRIMARY KEY,
      flagged_at_ms INTEGER NOT NULL
    );
  `);
}

interface HouseholdWindows {
  timeZone: string;
  escalationAfterMs: number;
  snoozeMinutes: number;
}

export class DoseAlarmChain {
  constructor(
    private readonly sql: SqlStorage,
    private readonly env: Env,
  ) {}

  // -------------------------------------------------------------------------
  // Identity
  // -------------------------------------------------------------------------

  /**
   * The household this DO belongs to, remembered because `alarm()` takes no arguments.
   *
   * Every other entry point is handed the id by the Worker route, which derives it from the
   * caller's token and never from a request body. An alarm has no caller, so the id has to have
   * been written down at some point when there was one.
   */
  rememberHousehold(householdId: string): void {
    this.sql.exec(
      "INSERT INTO alarm_meta (key, value) VALUES ('household_id', ?) " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      householdId,
    );
  }

  householdId(): string | null {
    const rows = this.sql
      .exec<{ value: string }>("SELECT value FROM alarm_meta WHERE key = 'household_id'")
      .toArray();
    return rows[0]?.value ?? null;
  }

  // -------------------------------------------------------------------------
  // Reading the household's synced state
  // -------------------------------------------------------------------------

  private async readWindows(householdId: string): Promise<HouseholdWindows | null> {
    const row = await this.env.DB.prepare(
      'SELECT payload FROM household_settings WHERE household_id = ?',
    )
      .bind(householdId)
      .first<{ payload: string }>();

    if (!row) {
      // No settings means no household timezone, and every wall-clock dose time resolves through
      // it. Arming alarms against a guessed zone would fire them at the wrong hour — plausibly,
      // consistently, and without an error. Fail closed (safety invariant 3): arm nothing until
      // the first device syncs its settings, which happens on its first run.
      return null;
    }

    const settings = JSON.parse(row.payload) as HouseholdSettings;
    return {
      timeZone: settings.timeZone,
      escalationAfterMs:
        (settings.escalationAfterMinutes || DEFAULT_ESCALATION_MINUTES) * MS_PER_MINUTE,
      snoozeMinutes: settings.snoozeMinutes || DEFAULT_SNOOZE_MINUTES,
    };
  }

  private async readPayloads<T>(
    sqlTable: string,
    householdId: string,
    where = '',
    ...params: string[]
  ): Promise<T[]> {
    const { results } = await this.env.DB.prepare(
      `SELECT payload FROM ${sqlTable} WHERE household_id = ?${where}`,
    )
      .bind(householdId, ...params)
      .all<{ payload: string }>();
    return results.map((row) => JSON.parse(row.payload) as T);
  }

  // -------------------------------------------------------------------------
  // Horizon
  // -------------------------------------------------------------------------

  /**
   * Rebuilds the next 48 hours of scheduled doses.
   *
   * Called whenever a `schedules`, `medicines` or `householdSettings` record lands in
   * `applyBatch`, and whenever the chain runs dry. That is what makes a schedule edit cancel and
   * reschedule implicitly: there is no per-schedule alarm bookkeeping to keep in step, because
   * the horizon is derived from the schedules rather than maintained alongside them.
   *
   * Rows already resolved (`acknowledged`, `missed`) are kept until they age out of the window, so
   * a re-materialization cannot resurrect a dose a caregiver has already dealt with.
   */
  async materialize(householdId: string, nowMs: number): Promise<void> {
    this.rememberHousehold(householdId);

    const windows = await this.readWindows(householdId);
    if (!windows) {
      return;
    }

    const missedAfterMs = MISSED_AFTER_MINUTES * MS_PER_MINUTE;
    const fromMs = nowMs - missedAfterMs;
    const toMs = nowMs + HORIZON_MS;

    const [schedules, medicines, logs, snoozes] = await Promise.all([
      this.readPayloads<Schedule>('schedules', householdId),
      this.readPayloads<Medicine>('medicines', householdId),
      this.readPayloads<IntakeLog>(
        'intake_logs',
        householdId,
        ' AND scheduled_time IS NOT NULL AND scheduled_time >= ?',
        toIso(fromMs),
      ),
      this.readPayloads<DoseSnooze>(
        'dose_snoozes',
        householdId,
        ' AND created_at >= ?',
        toIso(fromMs - missedAfterMs),
      ),
    ]);

    const medicinesById = new Map(medicines.map((medicine) => [medicine.id, medicine]));
    const occurrences = expandSchedules(schedules, { fromMs, toMs }, windows.timeZone);

    for (const occurrence of occurrences) {
      const medicine = medicinesById.get(occurrence.medicineId);
      if (!medicine || medicine.archived) {
        continue;
      }

      // A dose that already has an effective log — taken, skipped, corrected — is settled. So is
      // one already past the point of being marked missed: the server tracks a bounded window,
      // and inventing missed logs for arbitrary history is not this sweep's job.
      if (findLogForOccurrence(logs, occurrence) !== undefined) {
        continue;
      }

      const dueAtMs = fromIso(occurrence.dueAt);
      if (nowMs >= dueAtMs + missedAfterMs) {
        continue;
      }

      this.upsertOccurrence(occurrence, medicine, dueAtMs, snoozes, windows, nowMs);
    }

    // The sweep half of mark-and-sweep. Anything this pass did not produce is no longer owed:
    // it fell out of the window, its schedule was edited or stopped, its medicine was archived,
    // or a caregiver logged it. Deleting it is what makes a schedule edit *cancel* the old times
    // rather than quietly leave them armed alongside the new ones.
    this.sql.exec('DELETE FROM dose_alarms WHERE seen_at_ms < ?', nowMs);
  }

  /**
   * Inserts one occurrence, or refreshes the derived times of one already tracked.
   *
   * `ON CONFLICT DO UPDATE` deliberately leaves `state`, `snooze_count` and `fired_at_ms` alone:
   * re-materializing happens on every schedule edit, and it must never un-acknowledge a dose or
   * re-send an alert that already went out.
   */
  private upsertOccurrence(
    occurrence: Occurrence,
    medicine: Medicine,
    dueAtMs: number,
    snoozes: readonly DoseSnooze[],
    windows: HouseholdWindows,
    nowMs: number,
  ): void {
    const id = occurrenceKey(occurrence);
    const snooze = deriveSnoozeState(snoozes, id);
    const notifyAtMs = snooze.untilMs ?? dueAtMs;

    this.sql.exec(
      `INSERT INTO dose_alarms (
         occurrence_id, schedule_id, medicine_id, patient_id, medicine_name, dosage_quantity,
         due_at_ms, notify_at_ms, escalate_at_ms, missed_at_ms, state, snooze_count, fired_at_ms,
         seen_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)
       ON CONFLICT(occurrence_id) DO UPDATE SET
         medicine_name   = excluded.medicine_name,
         dosage_quantity = excluded.dosage_quantity,
         notify_at_ms    = excluded.notify_at_ms,
         escalate_at_ms  = excluded.escalate_at_ms,
         missed_at_ms    = excluded.missed_at_ms,
         seen_at_ms      = excluded.seen_at_ms`,
      id,
      occurrence.scheduleId,
      occurrence.medicineId,
      occurrence.patientId,
      medicine.name,
      occurrence.dosageQuantity,
      dueAtMs,
      notifyAtMs,
      notifyAtMs + windows.escalationAfterMs,
      dueAtMs + MISSED_AFTER_MINUTES * MS_PER_MINUTE,
      snooze.count,
      nowMs,
    );
  }

  // -------------------------------------------------------------------------
  // Acknowledgement — the reason no new channel is needed
  // -------------------------------------------------------------------------

  /**
   * A synced `IntakeLog` for a scheduled occurrence settles it.
   *
   * Any status counts, not just `taken`: a caregiver who marked a dose skipped has answered the
   * question the alert asked, and escalating to the other caregiver afterwards would be noise.
   * This is called from `applyBatch`, which already sees every write — "stopping immediately on
   * acknowledgement from any device" therefore falls out of the existing sync path with no new
   * channel, no polling and no push-back to the DO.
   */
  acknowledge(occurrenceId: string): void {
    this.sql.exec(
      "UPDATE dose_alarms SET state = 'acknowledged' WHERE occurrence_id = ? AND state != 'missed'",
      occurrenceId,
    );
  }

  /**
   * A synced `DoseSnooze` defers the whole chain for that occurrence.
   *
   * The deadline runs from the tap, not from the due time, matching `deriveSnoozeState` — the
   * client, the device's local alarm and this all read the same function, because a snooze that
   * silenced the phone but not the server would be worse than no snooze at all.
   *
   * `missed_at_ms` is deliberately not moved: three snoozes buy an hour, and the dose still
   * becomes missed three hours after it was due.
   */
  defer(snooze: DoseSnooze, escalationAfterMs: number): void {
    const untilMs = fromIso(snooze.createdAt) + snooze.minutes * MS_PER_MINUTE;
    this.sql.exec(
      `UPDATE dose_alarms
         SET state = 'pending',
             notify_at_ms = ?,
             escalate_at_ms = ?,
             snooze_count = MAX(snooze_count, ?),
             fired_at_ms = NULL
       WHERE occurrence_id = ? AND state != 'missed' AND state != 'acknowledged'`,
      untilMs,
      untilMs + escalationAfterMs,
      snooze.count,
      snooze.occurrenceId,
    );
  }

  /** The escalation window, needed by `defer`. Read here so callers don't duplicate the default. */
  async escalationAfterMs(householdId: string): Promise<number> {
    const windows = await this.readWindows(householdId);
    return windows?.escalationAfterMs ?? DEFAULT_ESCALATION_MINUTES * MS_PER_MINUTE;
  }

  // -------------------------------------------------------------------------
  // The chain itself
  // -------------------------------------------------------------------------

  /**
   * The next instant at which any tracked occurrence needs something done, or `null` when the
   * chain has run dry.
   *
   * A Durable Object holds exactly one alarm, so a schedule is a chain of alarms rather than a
   * set of timers — the same mechanism Sprint 0's push burst proved out, applied to real doses.
   */
  nextWakeMs(): number | null {
    const rows = this.sql
      .exec<{ next_at: number | null }>(
        `SELECT MIN(
           CASE state
             WHEN 'pending'   THEN MIN(notify_at_ms, missed_at_ms)
             WHEN 'notified'  THEN MIN(escalate_at_ms, missed_at_ms)
             WHEN 'escalated' THEN missed_at_ms
           END
         ) AS next_at
         FROM dose_alarms
         WHERE state IN ('pending', 'notified', 'escalated')`,
      )
      .toArray();
    return rows[0]?.next_at ?? null;
  }

  /**
   * Does everything owed as of `nowMs`.
   *
   * Deliberately does not re-check that the alarm was armed for exactly this moment: alarms fire
   * early and late, and gating on a clock comparison would silently drop a dose alert. Lateness
   * is handled honestly instead — an alert whose escalation deadline has *also* passed skips
   * straight to escalation rather than telling a caregiver a two-hour-old dose is "due now".
   */
  async runDueWork(nowMs: number): Promise<void> {
    const householdId = this.householdId();
    if (!householdId) {
      return;
    }

    const due = this.sql
      .exec<DoseAlarmRow>(
        `SELECT * FROM dose_alarms
          WHERE state IN ('pending', 'notified', 'escalated')
            AND CASE state
                  WHEN 'pending'   THEN MIN(notify_at_ms, missed_at_ms)
                  WHEN 'notified'  THEN MIN(escalate_at_ms, missed_at_ms)
                  WHEN 'escalated' THEN missed_at_ms
                END <= ?
          ORDER BY due_at_ms
          LIMIT ?`,
        nowMs,
        MAX_WORK_PER_WAKE,
      )
      .toArray();

    for (const row of due) {
      if (nowMs >= row.missed_at_ms) {
        await this.markMissed(householdId, row);
        continue;
      }

      if (nowMs >= row.escalate_at_ms) {
        await this.escalate(householdId, row, nowMs);
        continue;
      }

      await this.notify(householdId, row, nowMs);
    }
  }

  private occurrencePayload(row: DoseAlarmRow, nowMs: number): Omit<DosePushPayload, 'kind'> {
    return {
      v: PUSH_PAYLOAD_VERSION,
      sentAtIso: toIso(nowMs),
      occurrenceId: row.occurrence_id,
      medicineId: row.medicine_id,
      medicineName: row.medicine_name,
      scheduleId: row.schedule_id,
      dueAtIso: toIso(row.due_at_ms),
      dosageQuantity: row.dosage_quantity,
    };
  }

  private async notify(householdId: string, row: DoseAlarmRow, nowMs: number): Promise<void> {
    await dispatchToHousehold(this.env, householdId, {
      ...this.occurrencePayload(row, nowMs),
      kind: 'dose',
    });
    this.sql.exec(
      "UPDATE dose_alarms SET state = 'notified', fired_at_ms = ? WHERE occurrence_id = ?",
      nowMs,
      row.occurrence_id,
    );
  }

  /**
   * The escalation, to every device in the household.
   *
   * No device is excluded, including the one that got the first alert: the point is that a dose
   * has gone unanswered, and whoever is nearest the child should hear about it. On Android this
   * arrives on the `dose_escalation_v1` channel, which is the one permitted to bypass Do Not
   * Disturb and — where the platform allows it — take the screen (delta AD4).
   */
  private async escalate(householdId: string, row: DoseAlarmRow, nowMs: number): Promise<void> {
    await dispatchToHousehold(this.env, householdId, {
      ...this.occurrencePayload(row, nowMs),
      kind: 'escalation',
      minutesUnacknowledged: Math.max(0, Math.round((nowMs - row.due_at_ms) / MS_PER_MINUTE)),
    });
    this.sql.exec(
      "UPDATE dose_alarms SET state = 'escalated' WHERE occurrence_id = ?",
      row.occurrence_id,
    );
  }

  /**
   * Writes the dose off as missed (delta AD6).
   *
   * A real, append-only `IntakeLog`, not a status the UI derives: it is a fact in a child's
   * medical record, a caregiver can correct it the same way any other log is corrected (a new log
   * superseding it — safety invariant 1), and it syncs to every device like anything else.
   *
   * Attributed to `system`, honestly. Safety invariant 5 requires every log to record who; the
   * truthful answer here is that no human recorded anything, which is exactly what makes this
   * entry meaningful.
   *
   * `actualTime` is the moment the dose *became* missed rather than the moment this DO happened
   * to wake up, so a late alarm cannot move a timestamp in the medical record.
   */
  private async markMissed(householdId: string, row: DoseAlarmRow): Promise<void> {
    if (await this.isShabbatMode()) {
      return;
    }

    const record = {
      // Through the sanctioned generator rather than `crypto.randomUUID()` directly — the same
      // no-ambient-identity rule every other writer of a domain record follows.
      id: uuidIdGenerator.next(),
      patientId: row.patient_id,
      medicineId: row.medicine_id,
      scheduleId: row.schedule_id,
      type: 'scheduled' as const,
      status: 'missed' as const,
      scheduledTime: toIso(row.due_at_ms),
      actualTime: toIso(row.missed_at_ms),
      quantityTaken: 0,
      loggedByUserId: 'system',
      loggedByDeviceId: 'system',
      syncStatus: 'synced' as const,
    };

    await applyRecord(this.env.DB, householdId, 'intakeLogs', record);
    this.sql.exec(
      "UPDATE dose_alarms SET state = 'missed' WHERE occurrence_id = ?",
      row.occurrence_id,
    );
  }

  /**
   * Shabbat suppresses the missed sweep entirely: in mode the app writes `pending_shabbat` and
   * reconciles after Havdalah, so a machine-written `missed` would be both wrong and a record a
   * caregiver then has to correct.
   *
   * Always false until Sprint A5 computes zmanim windows server-side — this is the single place
   * that will need to change, deliberately, rather than a check scattered through the chain.
   */
  private isShabbatMode(): Promise<boolean> {
    return Promise.resolve(false);
  }

  // -------------------------------------------------------------------------
  // Low stock (PRD §2.4)
  // -------------------------------------------------------------------------

  /**
   * Notifies once when stock crosses down through the refill threshold, and re-arms only when a
   * refill takes it back above.
   *
   * The flag is what makes it once rather than once per dose: without it, every subsequent dose
   * of an already-low medicine would push again, and a caregiver who has learned to ignore the
   * low-stock notification is worse off than one who never got it.
   */
  async evaluateLowStock(
    householdId: string,
    medicineIds: Iterable<string>,
    nowMs: number,
  ): Promise<void> {
    const ids = [...new Set(medicineIds)];
    if (ids.length === 0) {
      return;
    }

    const [items, adjustments, medicines] = await Promise.all([
      this.readPayloads<InventoryItem>('inventory_items', householdId),
      this.readPayloads<InventoryAdjustment>('inventory_adjustments', householdId),
      this.readPayloads<Medicine>('medicines', householdId),
    ]);

    for (const medicineId of ids) {
      const item = items.find((candidate) => candidate.medicineId === medicineId);
      if (!item) {
        continue;
      }

      const state = deriveInventoryState(item, adjustments);
      const flagged =
        this.sql
          .exec<{ n: number }>(
            'SELECT COUNT(*) AS n FROM low_stock_flags WHERE medicine_id = ?',
            medicineId,
          )
          .one().n > 0;

      if (!state.isLow) {
        if (flagged) {
          this.sql.exec('DELETE FROM low_stock_flags WHERE medicine_id = ?', medicineId);
        }
        continue;
      }

      if (flagged) {
        continue;
      }

      const medicine = medicines.find((candidate) => candidate.id === medicineId);
      this.sql.exec(
        'INSERT INTO low_stock_flags (medicine_id, flagged_at_ms) VALUES (?, ?)',
        medicineId,
        nowMs,
      );

      await dispatchToHousehold(
        this.env,
        householdId,
        {
          v: PUSH_PAYLOAD_VERSION,
          kind: 'low_stock',
          sentAtIso: toIso(nowMs),
          medicineId,
          medicineName: medicine?.name ?? 'A medicine',
          remaining: state.currentQuantity,
          threshold: state.refillThreshold,
          unitName: state.unitName,
        },
        // A refill alert is not time-critical the way a dose alert is: it is worth delivering an
        // hour later to a phone that was off, where a stale "dose due now" would invite a second dose.
        { ttlSeconds: 60 * 60 },
      );
    }
  }
}
