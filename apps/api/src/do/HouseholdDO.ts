import { DurableObject } from 'cloudflare:workers';
import { assessDose, blockReasonFor, fromIso, systemClock } from '@medguard/shared';
import type {
  Clock,
  IntakeLog,
  LiveMessage,
  Medicine,
  ProbePushLog,
  ProbePushPayload,
  ProbeSendRecord,
  SyncableTable,
} from '@medguard/shared';
import { readVapidConfig, sendPush } from '../push/send.js';
import type { PushSubscription } from '../push/send.js';
import { applyRecord, currentCursor } from '../sync/repository.js';
import type { PushOutcome } from '../sync/repository.js';

/**
 * One Durable Object per household.
 *
 * A DO is single-threaded, which is exactly what the safety model needs: it is the one place
 * where two caregivers' concurrent PRN doses can be serialized and re-checked authoritatively
 * before either is accepted — the fix for local-first sync otherwise letting two devices both
 * think a dose is safe and administer it inside the same cooldown window. Sprint 4 adds the
 * WebSocket Hibernation API and the broadcast fan-out.
 *
 * Sprint 0 uses it to retire two Sprint 5 risks early: that DO Alarms can drive scheduled Web
 * Push at all, and that a push actually arrives on a locked phone.
 */

// The index signature is what SqlStorage's exec<T>() requires of a row type.
interface QueuedPush extends Record<string, SqlStorageValue> {
  id: number;
  due_at_ms: number;
  subscription: string;
  payload: string;
}

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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS probe_push_queue (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          due_at_ms    INTEGER NOT NULL,
          subscription TEXT NOT NULL,
          payload      TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS probe_push_log (
          id     INTEGER PRIMARY KEY AUTOINCREMENT,
          record TEXT NOT NULL
        );
      `);
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
    // Logs blocked earlier in *this* batch, so their paired inventory adjustment (a separate
    // change with its own id) is blocked too, even before it would otherwise be visible in D1.
    const blockedLogIds = new Set<string>();

    for (const change of changes) {
      const id = String(change.record.id);

      if (change.table === 'intakeLogs' && change.record.status === 'taken') {
        const verdict = await this.checkDoseSafety(householdId, change.record);
        if (verdict.blockedReason) {
          blockedLogIds.add(id);
          results.push({ table: change.table, id, outcome: 'blocked', ...verdict });
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
    }

    const cursor = await currentCursor(this.env.DB, householdId);

    if (results.some((result) => result.outcome === 'applied')) {
      this.broadcast({ type: 'sync', cursor });
    }

    return { cursor, results };
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

    const { results: logRows } = await this.env.DB.prepare(
      'SELECT payload FROM intake_logs WHERE household_id = ? AND medicine_id = ?',
    )
      .bind(householdId, medicineId)
      .all<{ payload: string }>();
    // Excludes the incoming record's own id: on a resend of an already-applied log (the whole
    // point of the append-only dedup below), the stored copy of *itself* would otherwise appear
    // in its own comparison history and get blocked as a cooldown violation against itself.
    const recordId = String(record.id);
    const logs = logRows
      .map((row) => JSON.parse(row.payload) as IntakeLog)
      .filter((log) => log.id !== recordId);

    const actualTimeIso = String(record.actualTime);
    const actualTimeMs = fromIso(actualTimeIso);
    const clock: Clock = { nowMs: () => actualTimeMs, nowIso: () => actualTimeIso };

    // The server is its own clock — there is no skew to distrust here, only the device's.
    const safety = assessDose({ medicine, logs, clock, clockTrust: { kind: 'trusted', offsetMs: 0 } });

    if (safety.state === 'safe') {
      return {};
    }

    const reason = blockReasonFor(safety)!;
    const attemptedByUserId = String(record.loggedByUserId ?? '');

    this.broadcast({
      type: 'safety.warning',
      medicineId,
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
  // Sprint 0 push probe
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

  /**
   * Queues a burst of pushes and arms the alarm for the earliest one.
   *
   * The delay exists so the probe is usable at all: you press the button, lock the phone, put it
   * down, and the push has to arrive at a genuinely locked screen. Testing it with the browser
   * in the foreground would prove nothing.
   */
  async schedulePushBurst(
    subscription: PushSubscription,
    payloads: ProbePushPayload[],
    firstDelayMs: number,
    spacingMs: number,
  ): Promise<{ scheduled: number; firstDueAtIso: string }> {
    this.ctx.storage.sql.exec('DELETE FROM probe_push_queue');
    this.ctx.storage.sql.exec('DELETE FROM probe_push_log');

    const now = systemClock.nowMs();
    const serialisedSubscription = JSON.stringify(subscription);

    payloads.forEach((payload, index) => {
      this.ctx.storage.sql.exec(
        'INSERT INTO probe_push_queue (due_at_ms, subscription, payload) VALUES (?, ?, ?)',
        now + firstDelayMs + index * spacingMs,
        serialisedSubscription,
        JSON.stringify(payload),
      );
    });

    const firstDueAtMs = now + firstDelayMs;
    await this.ctx.storage.setAlarm(firstDueAtMs);

    return { scheduled: payloads.length, firstDueAtIso: new Date(firstDueAtMs).toISOString() };
  }

  /** What the server actually did, so a missing notification can be told apart from a failed send. */
  async getProbeLog(): Promise<ProbePushLog> {
    const sent = this.ctx.storage.sql
      .exec<{ record: string }>('SELECT record FROM probe_push_log ORDER BY id')
      .toArray()
      .map((row) => JSON.parse(row.record) as ProbeSendRecord);

    const pending = this.ctx.storage.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM probe_push_queue')
      .one().n;

    return { pending, sent };
  }

  /**
   * Sends the earliest queued push, then re-arms for the next.
   *
   * Deliberately does not re-check the due time. The alarm is only ever armed for the earliest
   * queued item, so if it fired, that item is what is owed — and alarms legitimately fire early
   * or late, so gating on a clock comparison would silently drop doses. Lateness is recorded as
   * a measurement rather than acted on.
   */
  override async alarm(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec<QueuedPush>('SELECT * FROM probe_push_queue ORDER BY due_at_ms, id LIMIT 1')
      .toArray();

    const row = rows[0];
    if (!row) return;

    const vapid = readVapidConfig(this.env);
    const payload = JSON.parse(row.payload) as ProbePushPayload;
    const sentAtMs = systemClock.nowMs();
    payload.sentAtIso = new Date(sentAtMs).toISOString();

    const result = vapid
      ? await sendPush(JSON.parse(row.subscription) as PushSubscription, payload, vapid)
      : ({ ok: false, status: 0, error: 'VAPID keys not configured', expired: false } as const);

    const record: ProbeSendRecord = {
      burstIndex: payload.burstIndex,
      burstTotal: payload.burstTotal,
      dueAtIso: new Date(row.due_at_ms).toISOString(),
      sentAtIso: payload.sentAtIso,
      latenessMs: sentAtMs - row.due_at_ms,
      ok: result.ok,
      status: result.status,
      ...(result.ok ? {} : { error: result.error }),
    };

    this.ctx.storage.sql.exec(
      'INSERT INTO probe_push_log (record) VALUES (?)',
      JSON.stringify(record),
    );
    this.ctx.storage.sql.exec('DELETE FROM probe_push_queue WHERE id = ?', row.id);

    // A Durable Object holds one alarm at a time, so a burst is a chain of alarms rather than
    // a single timer. This is the same mechanism Sprint 5 uses for dose scheduling.
    const next = this.ctx.storage.sql
      .exec<{ due_at_ms: number | null }>('SELECT MIN(due_at_ms) AS due_at_ms FROM probe_push_queue')
      .one().due_at_ms;

    if (next !== null) {
      await this.ctx.storage.setAlarm(next);
    }
  }
}
