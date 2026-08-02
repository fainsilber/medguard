import { DurableObject } from 'cloudflare:workers';

/**
 * One Durable Object per household.
 *
 * A DO is single-threaded, which is exactly what the safety model needs: it is the one place
 * where two caregivers' concurrent PRN doses can be serialized and re-checked authoritatively
 * before either is accepted (delta D2). Sprint 4 adds the WebSocket Hibernation API and the
 * broadcast fan-out; Sprint 5 adds the alarm handlers for dose pushes and escalation.
 *
 * Sprint 0 proves two things only: the DO is reachable, and its storage is genuinely
 * SQLite-backed — which is what keeps this on the Cloudflare free plan.
 */
export class HouseholdDO extends DurableObject<Env> {
  /**
   * Confirms SQLite-backed storage is live. `storage.sql` only exists on SQLite-backed classes;
   * on a KV-backed class this throws, which is what makes it a meaningful check rather than
   * a formality.
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
}
