import { DurableObject } from 'cloudflare:workers';
import { systemClock } from '@medguard/shared';
import type { ProbePushLog, ProbePushPayload, ProbeSendRecord } from '@medguard/shared';
import { readVapidConfig, sendPush } from '../push/send.js';
import type { PushSubscription } from '../push/send.js';

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
