import {
  DEFAULT_ESCALATION_MINUTES,
  DEFAULT_SNOOZE_MINUTES,
  MISSED_AFTER_MINUTES,
  MS_PER_MINUTE,
  PUSH_PAYLOAD_VERSION,
  SHABBAT_BURST_COUNT,
  SHABBAT_BURST_SPACING_MS,
  deriveInventoryState,
  deriveSnoozeState,
  expandSchedules,
  findLogForOccurrence,
  fromIso,
  occurrenceKey,
  shabbatModeAt,
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
  Patient,
  Schedule,
  ShabbatConfig,
  ShabbatWindow,
} from '@medguard/shared';
import { dispatchToHousehold } from '../push/dispatch.js';
import { publishWindowsIfStale } from '../shabbat/publish.js';
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

/**
 * `pending → notified → escalated`, and out via `acknowledged` or `missed`.
 *
 * `pending_shabbat` (Sprint A5) is a fifth terminal state, not a stage: a dose alerted while the
 * household was in Shabbat mode has had everything done for it that will be done until Havdalah —
 * no escalation, no missed sweep — and the row records *why* it stopped rather than pretending it
 * was acknowledged.
 */
type AlarmState =
  'pending' | 'notified' | 'escalated' | 'acknowledged' | 'missed' | 'pending_shabbat';

interface DoseAlarmRow extends Record<string, SqlStorageValue> {
  occurrence_id: string;
  schedule_id: string;
  medicine_id: string;
  patient_id: string;
  medicine_name: string;
  patient_name: string;
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
      seen_at_ms      INTEGER NOT NULL DEFAULT 0,
      -- Multi-patient (Phase 4): denormalized the same way medicine_name is, so a notification can
      -- name whose dose it is without a database read on a woken device.
      patient_name    TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_dose_alarms_state ON dose_alarms(state, notify_at_ms);
    CREATE TABLE IF NOT EXISTS low_stock_flags (
      medicine_id   TEXT PRIMARY KEY,
      flagged_at_ms INTEGER NOT NULL
    );
    -- Sprint A5. The Shabbat burst for web-push devices: several notifications ~1.1s apart
    -- approximating a 45-second chime out of what a browser can actually deliver (delta D1).
    -- Held as a schedule rather than run as a sleep loop inside one alarm wake, so each push is
    -- an ordinary step of the same chain everything else uses — assertable under
    -- runDurableObjectAlarm, and unaffected by the wake that started it being cut short.
    --
    -- Self-contained rather than joined back to dose_alarms: a re-materialization can delete the
    -- dose row (the dose now has a pending_shabbat log, so it is no longer owed) while the burst
    -- is still mid-flight, and half a chime is worse than none.
    CREATE TABLE IF NOT EXISTS shabbat_bursts (
      occurrence_id   TEXT PRIMARY KEY,
      schedule_id     TEXT NOT NULL,
      medicine_id     TEXT NOT NULL,
      medicine_name   TEXT NOT NULL,
      dosage_quantity REAL NOT NULL,
      due_at_ms       INTEGER NOT NULL,
      -- 1-based, and always the push *not yet sent*: the first goes out inline with the alert.
      next_index      INTEGER NOT NULL,
      next_at_ms      INTEGER NOT NULL,
      -- Multi-patient (Phase 4): this table carries no other link back to dose_alarms once the
      -- burst is running (see the comment above), so who the dose belongs to has to be denormalized
      -- in here too, the same as medicine_name already is.
      patient_id      TEXT NOT NULL DEFAULT '',
      patient_name    TEXT NOT NULL DEFAULT ''
    );
  `);

  // `CREATE TABLE IF NOT EXISTS` is a no-op against a Durable Object whose tables were created
  // before this column existed — unlike the D1 migrations (`apps/api/migrations/`), there is no
  // versioned migration runner for a DO's own SQLite storage, so a column added here has to be
  // backfilled onto already-running households by hand, once, guarded by a check rather than by a
  // migration number.
  ensureColumn(sql, 'dose_alarms', 'patient_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(sql, 'shabbat_bursts', 'patient_id', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(sql, 'shabbat_bursts', 'patient_name', "TEXT NOT NULL DEFAULT ''");
}

/** Adds `column` to `table` if it isn't already there — see the comment above `createAlarmTables`. */
function ensureColumn(sql: SqlStorage, table: string, column: string, definition: string): void {
  const existing = sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray();
  if (!existing.some((row) => row.name === column)) {
    sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
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

    // Sprint A5. Materialization is the one thing that reliably happens for every household that
    // is still alive — on every write, and whenever the chain runs dry — so it is where the
    // Shabbat horizon is topped up. A household that set its coordinates once and never touched
    // them again still has windows months later, with nothing having to remember to ask.
    await publishWindowsIfStale(this.env.DB, householdId, nowMs);

    const missedAfterMs = MISSED_AFTER_MINUTES * MS_PER_MINUTE;
    const fromMs = nowMs - missedAfterMs;
    const toMs = nowMs + HORIZON_MS;

    const [schedules, medicines, logs, snoozes, patients] = await Promise.all([
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
      this.readPayloads<Patient>('patients', householdId),
    ]);

    const medicinesById = new Map(medicines.map((medicine) => [medicine.id, medicine]));
    const patientNamesById = new Map(patients.map((patient) => [patient.id, patient.displayName]));
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

      const patientName = patientNamesById.get(occurrence.patientId) ?? '';
      this.upsertOccurrence(occurrence, medicine, patientName, dueAtMs, snoozes, windows, nowMs);
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
    patientName: string,
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
         seen_at_ms, patient_name
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?)
       ON CONFLICT(occurrence_id) DO UPDATE SET
         medicine_name   = excluded.medicine_name,
         dosage_quantity = excluded.dosage_quantity,
         notify_at_ms    = excluded.notify_at_ms,
         escalate_at_ms  = excluded.escalate_at_ms,
         missed_at_ms    = excluded.missed_at_ms,
         seen_at_ms      = excluded.seen_at_ms,
         patient_name    = excluded.patient_name`,
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
      patientName,
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

    // A burst in flight is owed work too — its remaining pushes are ~1.1 seconds apart, which is
    // sooner than any dose, so this is usually what the next wake is for.
    const burst = this.sql
      .exec<{ next_at: number | null }>('SELECT MIN(next_at_ms) AS next_at FROM shabbat_bursts')
      .toArray();

    const candidates = [rows[0]?.next_at, burst[0]?.next_at].filter(
      (value): value is number => typeof value === 'number',
    );
    return candidates.length === 0 ? null : Math.min(...candidates);
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

    // Once per wake, not once per row (Sprint A5). Everything below branches on it, and a
    // household is either in Shabbat or not for the whole of one wake.
    const inShabbatMode = await this.isShabbatMode(householdId, nowMs);

    await this.runDueBursts(householdId, nowMs);

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
        await this.markMissed(householdId, row, inShabbatMode);
        continue;
      }

      if (nowMs >= row.escalate_at_ms) {
        if (inShabbatMode) {
          // The dose already alerted, before Shabbat began, and nobody answered. Escalating now
          // would be a second notification during Shabbat for a dose that has already been
          // announced — and per docs/halachic-decisions.md Q3 escalation has nothing to add in
          // mode anyway, since the first alert reached every device. It goes to reconciliation.
          await this.markPendingShabbat(householdId, row);
          continue;
        }
        await this.escalate(householdId, row, nowMs);
        continue;
      }

      await this.notify(householdId, row, nowMs, inShabbatMode);
    }
  }

  private async occurrencePayload(
    householdId: string,
    row: DoseAlarmRow,
    nowMs: number,
  ): Promise<Omit<DosePushPayload, 'kind'>> {
    const patientName = (await this.isMultiPatientHousehold(householdId))
      ? row.patient_name
      : undefined;
    return {
      v: PUSH_PAYLOAD_VERSION,
      sentAtIso: toIso(nowMs),
      occurrenceId: row.occurrence_id,
      medicineId: row.medicine_id,
      medicineName: row.medicine_name,
      scheduleId: row.schedule_id,
      dueAtIso: toIso(row.due_at_ms),
      dosageQuantity: row.dosage_quantity,
      ...(patientName ? { patientName } : {}),
    };
  }

  /**
   * Whether this household has more than one active patient — the same rule that decides whether
   * a name gets prefixed onto a push title (`describePush`'s `patientName`) or a local alarm's
   * title (`apps/android/src/alarms/horizon.ts`). Archived patients don't count: a household back
   * down to one active patient reads like a single-patient one again, even if a past patient's
   * name is still on file.
   */
  private async isMultiPatientHousehold(householdId: string): Promise<boolean> {
    const patients = await this.readPayloads<Patient>('patients', householdId);
    return patients.filter((patient) => !patient.archived).length > 1;
  }

  private async notify(
    householdId: string,
    row: DoseAlarmRow,
    nowMs: number,
    inShabbatMode: boolean,
  ): Promise<void> {
    if (inShabbatMode) {
      await this.notifyShabbat(householdId, row, nowMs);
      return;
    }

    await dispatchToHousehold(this.env, householdId, {
      ...(await this.occurrencePayload(householdId, row, nowMs)),
      kind: 'dose',
    });
    this.sql.exec(
      "UPDATE dose_alarms SET state = 'notified', fired_at_ms = ? WHERE occurrence_id = ?",
      nowMs,
      row.occurrence_id,
    );
  }

  /**
   * The Shabbat dose alert (delta D5, and `docs/halachic-decisions.md` Q1/Q3).
   *
   * Three things distinguish it from the weekday alert, and each is a halachic requirement rather
   * than a preference:
   *
   *   1. **`kind: 'shabbat'`** — which carries no action buttons on either client, because
   *      tapping one writes a record. What happened is recorded after Havdalah instead.
   *   2. **No escalation afterwards.** Not suppressed — structurally unnecessary. The alert
   *      already went to every registered device, so there is nobody left to escalate to.
   *   3. **A burst for web-push devices only.** A browser notification is a ~1-2 second tone, so
   *      ten of them ~1.1s apart approximate the PRD's 45-second chime. A native device plays the
   *      real chime from its own local alarm and gets exactly one push (delta AD3) — ten would be
   *      ten notifications, not a longer chime.
   *
   * The `pending_shabbat` log is written here rather than at Havdalah so the record exists from
   * the moment the alert fires: the reconciliation sheet has a definite worklist even if the
   * phone that heard the chime never comes back online.
   */
  private async notifyShabbat(
    householdId: string,
    row: DoseAlarmRow,
    nowMs: number,
  ): Promise<void> {
    const payload = await this.occurrencePayload(householdId, row, nowMs);

    // Native first, and exactly one: `burstTotal: 1` is the honest description of what this
    // device is being sent, and it is what the client reads to know it is not mid-burst.
    await dispatchToHousehold(
      this.env,
      householdId,
      { ...payload, kind: 'shabbat', burstIndex: 1, burstTotal: 1 },
      { providers: ['fcm'] },
    );

    const webTargets = await dispatchToHousehold(
      this.env,
      householdId,
      { ...payload, kind: 'shabbat', burstIndex: 1, burstTotal: SHABBAT_BURST_COUNT },
      { providers: ['webpush'] },
    );

    // Only schedule the rest of the burst if there is a browser to hear it. A household on
    // native-only phones would otherwise wake this object nine more times to send nothing.
    //
    // And only one chain per *instant*. Several medicines given at 08:00 is the ordinary case, not
    // an edge one, and a chain each would mean twenty or thirty notification tones for what a
    // caregiver hears as a single alert going off — the browser-side version of the same "one
    // sound, several notifications" rule the native chime now follows. Each dose still gets its
    // own initial push above, so the count of notifications is unchanged; what is deduplicated is
    // the repetition that stands in for a chime.
    const chainAlreadyRunning = this.sql
      .exec<{ n: number }>(
        'SELECT COUNT(*) AS n FROM shabbat_bursts WHERE due_at_ms = ?',
        row.due_at_ms,
      )
      .toArray()[0];

    if (webTargets.length > 0 && SHABBAT_BURST_COUNT > 1 && (chainAlreadyRunning?.n ?? 0) === 0) {
      this.sql.exec(
        `INSERT INTO shabbat_bursts (
           occurrence_id, schedule_id, medicine_id, medicine_name, dosage_quantity, due_at_ms,
           next_index, next_at_ms, patient_id, patient_name
         ) VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?, ?)
         ON CONFLICT(occurrence_id) DO UPDATE SET next_index = 2, next_at_ms = excluded.next_at_ms`,
        row.occurrence_id,
        row.schedule_id,
        row.medicine_id,
        row.medicine_name,
        row.dosage_quantity,
        row.due_at_ms,
        nowMs + SHABBAT_BURST_SPACING_MS,
        row.patient_id,
        row.patient_name,
      );
    }

    await this.markPendingShabbat(householdId, row);
  }

  /**
   * The rest of a burst, one push per wake.
   *
   * Bounded by `MAX_WORK_PER_WAKE` like every other kind of owed work: a device that was
   * unreachable for a while must not turn one wake into an unbounded run of pushes.
   */
  private async runDueBursts(householdId: string, nowMs: number): Promise<void> {
    const due = this.sql
      .exec<{
        occurrence_id: string;
        schedule_id: string;
        medicine_id: string;
        medicine_name: string;
        dosage_quantity: number;
        due_at_ms: number;
        next_index: number;
        next_at_ms: number;
        patient_id: string;
        patient_name: string;
      }>(
        'SELECT * FROM shabbat_bursts WHERE next_at_ms <= ? ORDER BY next_at_ms LIMIT ?',
        nowMs,
        MAX_WORK_PER_WAKE,
      )
      .toArray();

    if (due.length === 0) {
      return;
    }

    // Once per wake rather than once per burst row: every row belongs to the same household, and
    // "does this household have more than one patient" doesn't change between rows of one wake.
    const showPatientName = await this.isMultiPatientHousehold(householdId);

    for (const burst of due) {
      await dispatchToHousehold(
        this.env,
        householdId,
        {
          v: PUSH_PAYLOAD_VERSION,
          kind: 'shabbat',
          sentAtIso: toIso(nowMs),
          occurrenceId: burst.occurrence_id,
          medicineId: burst.medicine_id,
          medicineName: burst.medicine_name,
          scheduleId: burst.schedule_id,
          dueAtIso: toIso(burst.due_at_ms),
          dosageQuantity: burst.dosage_quantity,
          burstIndex: burst.next_index,
          burstTotal: SHABBAT_BURST_COUNT,
          ...(showPatientName && burst.patient_name ? { patientName: burst.patient_name } : {}),
        },
        { providers: ['webpush'] },
      );

      if (burst.next_index >= SHABBAT_BURST_COUNT) {
        this.sql.exec('DELETE FROM shabbat_bursts WHERE occurrence_id = ?', burst.occurrence_id);
        continue;
      }

      // Spaced from the intended instant rather than from now, so a late wake catches up instead
      // of stretching the chime out past the point where it reads as one alert.
      this.sql.exec(
        'UPDATE shabbat_bursts SET next_index = ?, next_at_ms = ? WHERE occurrence_id = ?',
        burst.next_index + 1,
        burst.next_at_ms + SHABBAT_BURST_SPACING_MS,
        burst.occurrence_id,
      );
    }
  }

  /**
   * Writes the dose off as awaiting Motzei Shabbat reconciliation.
   *
   * A real, append-only `IntakeLog` with status `pending_shabbat`, on the same footing as the
   * `missed` log `markMissed` writes and for the same reason: it is a fact in a child's medical
   * record — an alert fired, and nothing was recorded because recording was not permitted — and
   * the reconciliation sheet corrects it by appending a superseding log, exactly as any other
   * correction works (safety invariant 1).
   *
   * `quantityTaken: 0` because nothing is known to have been given yet; the conformance suite
   * already asserts that a `pending_shabbat` log moves no stock, so the inventory ledger stays
   * untouched until a caregiver says what actually happened.
   *
   * Attributed to `system`: no human recorded anything, which is precisely what makes the entry
   * meaningful (safety invariant 5).
   */
  private async markPendingShabbat(householdId: string, row: DoseAlarmRow): Promise<void> {
    const record = {
      id: uuidIdGenerator.next(),
      patientId: row.patient_id,
      medicineId: row.medicine_id,
      scheduleId: row.schedule_id,
      type: 'scheduled' as const,
      status: 'pending_shabbat' as const,
      scheduledTime: toIso(row.due_at_ms),
      // The due time, not the moment this object happened to wake: a late alarm must not move a
      // timestamp in the medical record.
      actualTime: toIso(row.due_at_ms),
      quantityTaken: 0,
      loggedByUserId: 'system',
      loggedByDeviceId: 'system',
      syncStatus: 'synced' as const,
    };

    await applyRecord(this.env.DB, householdId, 'intakeLogs', record);
    this.sql.exec(
      "UPDATE dose_alarms SET state = 'pending_shabbat' WHERE occurrence_id = ?",
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
      ...(await this.occurrencePayload(householdId, row, nowMs)),
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
  private async markMissed(
    householdId: string,
    row: DoseAlarmRow,
    inShabbatMode: boolean,
  ): Promise<void> {
    if (inShabbatMode) {
      // Shabbat suppresses the missed sweep entirely (Sprint A5): in mode the record says
      // `pending_shabbat` and a caregiver settles it after Havdalah, so a machine-written
      // `missed` would be both wrong and something they then have to correct.
      await this.markPendingShabbat(householdId, row);
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
   * Whether the household is in Shabbat mode at `nowMs` (Sprint A5).
   *
   * Read from the windows this Worker published (`shabbat/publish.ts`) rather than computed here:
   * one calculation, on one calendar, that every device also holds. The SQL narrows to candidate
   * rows; `shabbatModeAt` from `@medguard/shared` decides — including the half-open boundary rule
   * — because the phone deciding which channel to arm calls exactly that function, and a
   * boundary the server and the phone disagree about is a dose that rings with action buttons on
   * Shabbat.
   *
   * Evaluated once per wake and passed down, not per row: it is two D1 reads.
   */
  private async isShabbatMode(householdId: string, nowMs: number): Promise<boolean> {
    const nowIso = toIso(nowMs);

    const [configRow, windowRows] = await Promise.all([
      this.env.DB.prepare(
        'SELECT payload FROM shabbat_config WHERE household_id = ? ORDER BY seq DESC LIMIT 1',
      )
        .bind(householdId)
        .first<{ payload: string }>(),
      this.env.DB.prepare(
        `SELECT payload FROM shabbat_windows
          WHERE household_id = ? AND starts_at <= ? AND ends_at > ?`,
      )
        .bind(householdId, nowIso, nowIso)
        .all<{ payload: string }>(),
    ]);

    if (!configRow) {
      return false;
    }

    const config = JSON.parse(configRow.payload) as ShabbatConfig;
    const windows = windowRows.results.map((row) => JSON.parse(row.payload) as ShabbatWindow);
    return shabbatModeAt(config, windows, nowMs);
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
