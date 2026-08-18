import { DurableObject } from 'cloudflare:workers';
import {
  assessDose,
  blockReasonFor,
  fromIso,
  resolveMaxSnoozeCount,
  systemClock,
} from '@medguard/shared';
import type {
  Clock,
  DoseSnooze,
  IntakeLog,
  LiveMessage,
  Medicine,
  SyncableTable,
} from '@medguard/shared';
import { publishWindows } from '../shabbat/publish.js';
import { applyRecord, currentCursor } from '../sync/repository.js';
import type { PushOutcome } from '../sync/repository.js';
import { DoseAlarmChain, createAlarmTables } from './doseAlarms.js';

/**
 * One Durable Object per household.
 *
 * A DO is single-threaded, which is exactly what the safety model needs: it is the one place
 * where two caregivers' concurrent PRN doses can be serialized and re-checked authoritatively
 * before either is accepted — the fix for local-first sync otherwise letting two devices both
 * think a dose is safe and administer it inside the same cooldown window. Sprint 4 adds the
 * WebSocket Hibernation API and the broadcast fan-out.
 *
 * Sprint A4 adds the second thing only a serialized, addressable-by-household object can do:
 * scheduling. `DoseAlarmChain` (see `doseAlarms.ts`) drives dose alerts, escalation and the
 * missed-dose sweep off this object's single `setAlarm`. It replaced the Sprint 0 push probe,
 * which had already answered its question — a push does reach a locked phone, on both platforms —
 * and whose unauthenticated relay route could not coexist with a shipped native client (AD8).
 */

export interface ApplyBatchChange {
  table: SyncableTable;
  record: Record<string, unknown>;
}

export interface ApplyBatchResult {
  table: SyncableTable;
  id: string;
  outcome: PushOutcome | 'blocked';
  /** Present only when outcome is 'blocked'. Not the `BlockReason` union verbatim — also covers
   *  the data-integrity cases (an orphaned adjustment, a medicine not yet synced) that aren't a
   *  dosing-safety verdict at all. */
  blockedReason?: string;
  availableAtIso?: string;
  msRemaining?: number;
}

export class HouseholdDO extends DurableObject<Env> {
  private readonly alarms: DoseAlarmChain;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.alarms = new DoseAlarmChain(ctx.storage.sql, env);
    ctx.blockConcurrencyWhile(async () => {
      createAlarmTables(this.ctx.storage.sql);
      // Sprint 0's probe queue, retired with the probe routes it existed for (delta AD8). Dropped
      // rather than left in place: a household's DO storage outlives a deploy, and a stale table
      // holding a caller-supplied push subscription is exactly the thing that route was removed for.
      this.ctx.storage.sql.exec('DROP TABLE IF EXISTS probe_push_queue');
      this.ctx.storage.sql.exec('DROP TABLE IF EXISTS probe_push_log');
    });
  }

  // -------------------------------------------------------------------------
  // Live channel: WebSocket Hibernation API
  // -------------------------------------------------------------------------

  /**
   * Upgrades to a WebSocket for this household's live channel.
   *
   * The Worker route (`GET /api/v1/sync/live`) authenticates the device and forwards the raw
   * request here — this method does no auth itself, it only accepts the socket. `acceptWebSocket`
   * (the Hibernation API) rather than a plain event listener is what lets this DO be evicted from
   * memory between messages without dropping the connection, so a household sitting idle overnight
   * doesn't hold this DO in memory (and billed) just to keep a socket open.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);

    // A browser's WebSocket API cannot set a custom header or send a body, so the device token
    // travels as a subprotocol instead of a bearer token — see the Worker route. The spec requires
    // echoing back exactly one of the client's offered subprotocols, or a compliant client treats
    // the handshake as failed.
    const requestedProtocol = request.headers.get('Sec-WebSocket-Protocol')?.split(',')[0]?.trim();

    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      ...(requestedProtocol ? { headers: { 'Sec-WebSocket-Protocol': requestedProtocol } } : {}),
    });
  }

  /** No client-initiated protocol yet — the channel is currently receive-only from the client's side. */
  override async webSocketMessage(): Promise<void> {
    // Intentionally ignored.
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }

  override async webSocketError(): Promise<void> {
    // The platform already tears the socket down. No per-connection state is kept outside what
    // ctx.getWebSockets() itself tracks, so there is nothing else to clean up.
  }

  /** Sends a JSON message to every device currently connected to this household's live channel. */
  private broadcast(message: LiveMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // A stale or closing socket must not stop the rest of the household from being notified.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Authoritative sync writes: the D2 double-dose guard and D3 ledger integrity
  // -------------------------------------------------------------------------

  /**
   * Applies one push batch. This is the only place data is written on the sync-push path — the
   * Worker route validates request shape, then delegates every change here, because a Durable
   * Object processes one call at a time. That serialization is what actually closes the race two
   * caregivers' phones can otherwise create: both see 🟢 locally, both push a dose for the same
   * medicine seconds apart, and without a single serialization point both could be accepted.
   *
   * Each change is applied and its result recorded independently — one malformed or blocked
   * record must never stop the rest of a caregiver's batch from syncing.
   */
  async applyBatch(
    householdId: string,
    changes: ApplyBatchChange[],
  ): Promise<{ cursor: number; results: ApplyBatchResult[] }> {
    const results: ApplyBatchResult[] = [];
    /** Only what actually landed, so the alarm chain never reacts to a duplicate or a loser. */
    const applied: ApplyBatchChange[] = [];
    // Logs blocked earlier in *this* batch, so their paired inventory adjustment (a separate
    // change with its own id) is blocked too, even before it would otherwise be visible in D1.
    const blockedLogIds = new Set<string>();

    for (const change of changes) {
      const id = String(change.record.id);

      // Checked before the safety re-check, deliberately: a dose somebody else has already
      // answered should not also be assessed for cooldown, which would broadcast a safety warning
      // to the whole household for what is really two people doing the right thing at once.
      if (change.table === 'intakeLogs' && typeof change.record.supersedesId === 'string') {
        const winner = await this.supersededBy(householdId, change.record.supersedesId, id);
        if (winner) {
          // Somebody already answered this dose. The first answer stands — the household's record
          // must not end up with two current truths for one dose, and the ledger must not
          // decrement stock twice for it (Sprint A5 phase 2).
          blockedLogIds.add(id);
          results.push({
            table: change.table,
            id,
            outcome: 'blocked',
            blockedReason: 'already_superseded',
          });
          this.broadcast({
            type: 'reconciliation.conflict',
            occurrenceId: `${String(change.record.scheduleId ?? '')}:${String(change.record.scheduledTime ?? '')}`,
            reconciledByUserId: winner.loggedByUserId,
            refusedDeviceId: String(change.record.loggedByDeviceId ?? ''),
          });
          continue;
        }
      }

      if (change.table === 'intakeLogs' && change.record.status === 'taken') {
        const verdict = await this.checkDoseSafety(householdId, change.record);
        if (verdict.blockedReason) {
          blockedLogIds.add(id);
          results.push({ table: change.table, id, outcome: 'blocked', ...verdict });
          continue;
        }
      }

      if (change.table === 'doseSnoozes') {
        const occurrenceId = String(change.record.occurrenceId);
        if (await this.snoozeLimitReached(householdId, occurrenceId, id)) {
          // The bound has to hold here, not only in the UI: a snooze is the one client-written
          // record that stops a server escalation, so a device with a stale or patched copy of
          // `MAX_SNOOZE_COUNT` could otherwise defer a dose indefinitely and silence the
          // escalation that exists to catch exactly that (delta AD5).
          results.push({
            table: change.table,
            id,
            outcome: 'blocked',
            blockedReason: 'snooze_limit_reached',
          });
          continue;
        }
      }

      if (change.table === 'inventoryAdjustments' && change.record.reason === 'dose') {
        const relatedLogId = change.record.relatedLogId;
        if (typeof relatedLogId === 'string') {
          const logWasAccepted =
            !blockedLogIds.has(relatedLogId) && (await this.logExists(householdId, relatedLogId));
          if (!logWasAccepted) {
            // The dose this would decrement stock for was never accepted — applying it anyway
            // would silently corrupt inventory for a dose that, as far as the record shows, never
            // happened (delta D3).
            results.push({
              table: change.table,
              id,
              outcome: 'blocked',
              blockedReason: 'related_log_not_accepted',
            });
            continue;
          }
        }
      }

      const outcome = await applyRecord(this.env.DB, householdId, change.table, change.record);
      results.push({ table: change.table, id, outcome });

      if (outcome === 'applied') {
        applied.push(change);
      }
    }

    const cursor = await currentCursor(this.env.DB, householdId);

    if (applied.length > 0) {
      this.broadcast({ type: 'sync', cursor });
      await this.reactToWrites(householdId, applied);
    }

    return { cursor, results };
  }

  /**
   * What an accepted write means for the alarm chain.
   *
   * This is the whole reason "escalation stops immediately on acknowledgement from any device"
   * needs no new channel: `applyBatch` is already the single write path for every synced record,
   * so a caregiver's dose log arriving from any phone lands here, and the chain simply reads it.
   *
   * Awaited rather than deferred to `waitUntil`. It is a handful of SQLite statements plus, at
   * most, one low-stock push on an actual threshold crossing — and getting it wrong means either
   * an escalation to a second caregiver for a dose that was already given, or a schedule edit
   * that quietly keeps firing the old times.
   */
  private async reactToWrites(householdId: string, applied: ApplyBatchChange[]): Promise<void> {
    const tables = new Set(applied.map((change) => change.table));

    for (const change of applied) {
      if (change.table === 'intakeLogs') {
        const { scheduleId, scheduledTime } = change.record;
        if (typeof scheduleId === 'string' && typeof scheduledTime === 'string') {
          this.alarms.acknowledge(`${scheduleId}:${scheduledTime}`);
        }
      }
    }

    if (tables.has('doseSnoozes')) {
      const escalationAfterMs = await this.alarms.escalationAfterMs(householdId);
      for (const change of applied) {
        if (change.table === 'doseSnoozes') {
          this.alarms.defer(change.record as unknown as DoseSnooze, escalationAfterMs);
        }
      }
    }

    // A schedule edit, a new medicine, an archived one, or a changed escalation window all move
    // what is owed and when. Re-deriving the whole horizon is what makes a schedule edit cancel
    // and reschedule implicitly, with no per-schedule bookkeeping to get out of step.
    if (tables.has('schedules') || tables.has('medicines') || tables.has('householdSettings')) {
      await this.alarms.materialize(householdId, systemClock.nowMs());
    } else {
      this.alarms.rememberHousehold(householdId);
    }

    // Sprint A5: new coordinates, a different candle-lighting offset, or the Israel/diaspora flag
    // flipping all change when Shabbat is. Republished immediately rather than at the next
    // horizon top-up, because a caregiver who just corrected the coordinates is very likely
    // looking at the verification screen waiting to see the times change.
    if (tables.has('shabbatConfig')) {
      await publishWindows(this.env.DB, householdId, systemClock.nowMs());
    }

    if (tables.has('inventoryAdjustments')) {
      const medicineIds = applied
        .filter((change) => change.table === 'inventoryAdjustments')
        .map((change) => String(change.record.medicineId));
      await this.alarms.evaluateLowStock(householdId, medicineIds, systemClock.nowMs());
    }

    await this.rearm();
  }

  /**
   * Points this object's single alarm at the next thing owed.
   *
   * A Durable Object holds one alarm at a time, so scheduling is a chain rather than a set of
   * timers: each wake does what is due and arms for whatever is next. When the chain runs dry the
   * horizon is re-derived, which is how a household whose alarms all fired yesterday picks up
   * tomorrow's without anything having to remember to ask.
   */
  private async rearm(): Promise<void> {
    let next = this.alarms.nextWakeMs();

    if (next === null) {
      const householdId = this.alarms.householdId();
      if (householdId) {
        await this.alarms.materialize(householdId, systemClock.nowMs());
        next = this.alarms.nextWakeMs();
      }
    }

    if (next !== null) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  /**
   * Counts the snoozes already recorded for an occurrence, excluding a resend of this very
   * record — a retried batch must stay idempotent, and re-counting a snooze against itself would
   * turn a dropped response into a refusal.
   */
  private async snoozeLimitReached(
    householdId: string,
    occurrenceId: string,
    snoozeId: string,
  ): Promise<boolean> {
    const [countRow, limit] = await Promise.all([
      this.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM dose_snoozes WHERE household_id = ? AND occurrence_id = ? AND id != ?',
      )
        .bind(householdId, occurrenceId, snoozeId)
        .first<{ n: number }>(),
      this.maxSnoozeCountFor(householdId),
    ]);
    return (countRow?.n ?? 0) >= limit;
  }

  /**
   * The household's configured snooze limit — `resolveMaxSnoozeCount()` applied to the
   * household's own record, the same fallback and clamp the client applies, so a stale or
   * corrupted setting can never widen (or, via a bad synced record, silently shrink to zero) how
   * many times a dose may be deferred here.
   */
  private async maxSnoozeCountFor(householdId: string): Promise<number> {
    const row = await this.env.DB.prepare(
      'SELECT max_snooze_count FROM household_settings WHERE household_id = ?',
    )
      .bind(householdId)
      .first<{ max_snooze_count: number | null }>();
    return resolveMaxSnoozeCount(row?.max_snooze_count ?? undefined);
  }

  /**
   * The log that already superseded `supersededId`, if some *other* record got there first
   * (Sprint A5 phase 2).
   *
   * This is what stops two caregivers double-logging the same Motzei Shabbat dose. Both open the
   * sheet, both answer the same dose, and both append a log naming the same `pending_shabbat`
   * record — `effectiveLogs` would then treat both as current truth, the Today view would pick
   * whichever came first in an array, and stock would be decremented twice for one dose.
   *
   * The check has to be here rather than in the UI: the two devices may both have been offline
   * and pushed seconds apart, and a Durable Object is the only place in the system where "has
   * anyone already answered this?" has a single answer.
   *
   * Excludes the incoming record's own id, so a resent batch — the retry path that append-only
   * dedup exists for — is a duplicate rather than a conflict with itself.
   */
  private async supersededBy(
    householdId: string,
    supersededId: string,
    incomingId: string,
  ): Promise<IntakeLog | undefined> {
    const { results } = await this.env.DB.prepare(
      'SELECT payload FROM intake_logs WHERE household_id = ? AND id != ?',
    )
      .bind(householdId, incomingId)
      .all<{ payload: string }>();

    return results
      .map((row) => JSON.parse(row.payload) as IntakeLog)
      .find((log) => log.supersedesId === supersededId);
  }

  private async logExists(householdId: string, logId: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      'SELECT 1 AS found FROM intake_logs WHERE household_id = ? AND id = ?',
    )
      .bind(householdId, logId)
      .first<{ found: number }>();
    return row !== null;
  }

  /**
   * The authoritative re-check for one administered dose, re-run against this household's actual
   * log history rather than trusted from whichever local copy the client evaluated against.
   *
   * Evaluated "as of" the dose's own `actualTime`, not the server's current clock: the question is
   * whether *this* dose was permitted given what else had already happened, which is what
   * correctly blocks the second of two near-simultaneous doses regardless of how long the request
   * took to arrive. (Doesn't handle a dose logged hours after the fact against history recorded
   * since — out of scope until Sprint 6's Shabbat reconciliation actually needs it.)
   *
   * An explicit override always wins, matching the client-side rule: a caregiver who deliberately
   * confirmed a blocked dose is not re-blocked by the server second-guessing them, only warned
   * about, via the broadcast every other caregiver also receives.
   */
  private async checkDoseSafety(
    householdId: string,
    record: Record<string, unknown>,
  ): Promise<{ blockedReason?: string; availableAtIso?: string; msRemaining?: number }> {
    const medicineId = String(record.medicineId);
    const override = record.override;
    const hasOverride =
      typeof override === 'object' &&
      override !== null &&
      typeof (override as { confirmedByUserId?: unknown }).confirmedByUserId === 'string';

    const medicineRow = await this.env.DB.prepare(
      'SELECT payload FROM medicines WHERE household_id = ? AND id = ?',
    )
      .bind(householdId, medicineId)
      .first<{ payload: string }>();

    // The medicine hasn't reached this household's server copy yet (or never will — malformed
    // data). Fail closed rather than assume it has no guard configured (safety invariant 3).
    if (!medicineRow) {
      return hasOverride ? {} : { blockedReason: 'medicine_not_found' };
    }

    const medicine = JSON.parse(medicineRow.payload) as Medicine;
    const patientId = String(record.patientId);

    // Scoped to this patient as well as this medicine: a medicine shared by several patients has
    // one cooldown/cap limit, but each patient's doses count against it independently (see
    // `AssessDoseInput` in `@medguard/shared`'s safety.ts) — Dad's dose must never block Mom's.
    const { results: logRows } = await this.env.DB.prepare(
      'SELECT payload FROM intake_logs WHERE household_id = ? AND medicine_id = ? AND patient_id = ?',
    )
      .bind(householdId, medicineId, patientId)
      .all<{ payload: string }>();
    const parsedLogs = logRows.map((row) => JSON.parse(row.payload) as IntakeLog);

    // Excludes the incoming record's own id: on a resend of an already-applied log (the whole
    // point of the append-only dedup below), the stored copy of *itself* would otherwise appear
    // in its own comparison history and get blocked as a cooldown violation against itself.
    //
    // Also excludes the whole chain of logs this one supersedes (a dose correction — see
    // `correctDose` in packages/store/src/repository.ts, which never deletes the original, only
    // links to it). Without this, correcting a dose's time leaves the original's stale `actualTime`
    // in the comparison history, so a correction that moves the time *earlier* can get blocked by
    // cooldown/cap math against the very record it's replacing.
    const recordId = String(record.id);
    const excludedIds = new Set<string>([recordId]);
    let supersededId = typeof record.supersedesId === 'string' ? record.supersedesId : undefined;
    while (supersededId && !excludedIds.has(supersededId)) {
      excludedIds.add(supersededId);
      supersededId = parsedLogs.find((log) => log.id === supersededId)?.supersedesId;
    }

    const logs = parsedLogs.filter((log) => !excludedIds.has(log.id));

    const actualTimeIso = String(record.actualTime);
    const actualTimeMs = fromIso(actualTimeIso);
    const clock: Clock = { nowMs: () => actualTimeMs, nowIso: () => actualTimeIso };

    // The server is its own clock — there is no skew to distrust here, only the device's.
    const safety = assessDose({
      medicine,
      patientId,
      logs,
      clock,
      clockTrust: { kind: 'trusted', offsetMs: 0 },
    });

    if (safety.state === 'safe') {
      return {};
    }

    const reason = blockReasonFor(safety)!;
    const attemptedByUserId = String(record.loggedByUserId ?? '');

    this.broadcast({
      type: 'safety.warning',
      medicineId,
      patientId,
      blockedBy: reason,
      attemptedByUserId,
      outcome: hasOverride ? 'overridden' : 'blocked',
    });

    if (hasOverride) {
      return {};
    }

    return {
      blockedReason: reason,
      ...(safety.state !== 'untrusted_clock'
        ? { availableAtIso: safety.availableAtIso, msRemaining: safety.msRemaining }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  /**
   * Confirms SQLite-backed storage is live. `storage.sql` only exists on SQLite-backed classes;
   * on a KV-backed class this throws, which is what makes it a meaningful check rather than a
   * formality — and KV-backed Durable Objects require a paid Workers plan.
   */
  async ping(): Promise<{ ok: true; storage: 'sqlite'; hits: number }> {
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS do_health (key TEXT PRIMARY KEY, hits INTEGER NOT NULL)',
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO do_health (key, hits) VALUES ('ping', 1)
       ON CONFLICT(key) DO UPDATE SET hits = hits + 1`,
    );

    // .one() throws unless there is exactly one row. The row was just upserted, so its absence
    // means storage is broken — which should be loud, not defaulted away.
    const row = this.ctx.storage.sql
      .exec<{ hits: number }>("SELECT hits FROM do_health WHERE key = 'ping'")
      .one();

    return { ok: true, storage: 'sqlite', hits: row.hits };
  }

  // -------------------------------------------------------------------------
  // The dose alarm chain (Sprint A4)
  // -------------------------------------------------------------------------

  /**
   * Arms this household's chain.
   *
   * Called when a device registers for push, so that a household which has not synced anything
   * since the last deploy still gets its alarms — the chain is otherwise only ever started by a
   * write landing in `applyBatch`.
   */
  async ensureAlarmsArmed(householdId: string): Promise<void> {
    await this.alarms.materialize(householdId, systemClock.nowMs());
    await this.rearm();
  }

  /**
   * Does whatever is owed, then arms for the next thing.
   *
   * Deliberately does not check that this is the exact moment the alarm was set for. Alarms fire
   * early and late — sometimes much later, after a household has been idle — and gating on a
   * clock comparison would silently drop a dose alert. `runDueWork` handles lateness honestly
   * instead: an alert whose escalation deadline has also passed escalates rather than announcing
   * that a two-hour-old dose is due now.
   */
  override async alarm(): Promise<void> {
    await this.alarms.runDueWork(systemClock.nowMs());
    await this.rearm();
  }
}
