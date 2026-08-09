import type { SyncableTable } from '@medguard/shared';
import type { MedGuardRepository } from './repository.js';
import { getCursor, setCursor, setLastSyncedAt } from './cursor.js';
import { applyPulledRecord, markSyncedLocally } from './tableDispatch.js';
import type { Store } from './types.js';

/**
 * Drains the local outbox and pulls remote deltas — the two halves of local-first sync.
 *
 * Deliberately framework-free: a plain class with async methods, so it is exactly as testable as
 * packages/shared's pure functions, and each platform's React (or React Native) layer is a thin
 * adapter rather than where the logic lives.
 *
 * Storage-agnostic since Sprint A1: the only platform-specific things this class needs — pushing
 * and pulling bytes over HTTP — are injected as `SyncApi`, so `apps/web` and `apps/android` share
 * this exact class rather than each keeping their own copy of the merge/outbox rules (safety
 * invariant 7 — no log lost across an offline→online cycle, no retry ever double-applying).
 */

/** Mirrors `apps/web/src/api/householdApi.ts`'s `ApiResult<T>` shape exactly, so the real
 * `syncApi.ts` module can be passed as a `SyncApi` with no adapter code.
 *
 * `code` is the raw, untranslated server error code (`apps/api/src/auth/middleware.ts`'s
 * `'unauthorized'`, say) alongside `error`'s already-user-facing message — optional and additive,
 * so an existing `SyncApi` that only ever set `error` still satisfies this type unchanged. It
 * exists so a caller like `SyncProvider` can react to *which* failure this was (a revoked device
 * needs a fundamentally different response than a dropped network call) without parsing a
 * human-readable string that only happens to still contain the word "unauthorized" today. */
export type SyncApiResult<T> = { ok: true; value: T } | { ok: false; error: string; code?: string };

/** Thrown by `drainOutbox()`/`pull()` on a failed `SyncApi` call — a plain `Error` with `.code`
 * attached so `SyncApiResult`'s `code` survives past the `throw`, for the same reason `code`
 * exists on `SyncApiResult` above. */
export class SyncApiError extends Error {
  readonly code: string | undefined;

  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = 'SyncApiError';
    this.code = code;
  }
}

export interface SyncPushResult {
  results: Array<{ id: string }>;
  blocked: Array<{ id: string }>;
  /** `id` is nullable upstream (`apps/api`'s rejection can precede id validation) — never
   * matches a real `entityId`, which is exactly the fail-closed behavior `drainOutbox()` wants. */
  rejected: Array<{ id: string | null }>;
}

export interface SyncPullResult {
  records: Array<{ table: SyncableTable; id: string; payload: unknown }>;
  cursor: number;
  hasMore?: boolean;
}

/** The HTTP half — `apps/web/src/api/syncApi.ts` today, an equivalent module on Android tomorrow. */
export interface SyncApi {
  bootstrap(apiBaseUrl: string, deviceToken: string): Promise<SyncApiResult<SyncPullResult>>;
  pull(apiBaseUrl: string, deviceToken: string, cursor: number): Promise<SyncApiResult<SyncPullResult>>;
  pushChanges(
    apiBaseUrl: string,
    deviceToken: string,
    changes: Array<{ table: string; record: unknown }>,
  ): Promise<SyncApiResult<SyncPushResult>>;
}

/** Structured log sink — `apps/web/src/logging/appLog.ts` today. Optional: silent if omitted. */
export interface SyncLog {
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const noopLog: SyncLog = { debug: () => {}, error: () => {} };

export interface SyncEngineDeps {
  store: Store;
  repository: MedGuardRepository;
  api: SyncApi;
  apiBaseUrl: string;
  deviceToken: string;
  householdId: string;
  log?: SyncLog;
}

/** Must stay at or under the server's own MAX_BATCH_SIZE (apps/api/src/routes/sync.ts). */
const PUSH_BATCH_SIZE = 200;

export class SyncEngine {
  private readonly log: SyncLog;
  private inFlight: Promise<void> | null = null;
  private queued: Promise<void> | null = null;

  constructor(private readonly deps: SyncEngineDeps) {
    this.log = deps.log ?? noopLog;
  }

  /**
   * Uploads pending local changes, oldest first, in bounded batches.
   *
   * An entry the server has authoritatively resolved — applied, a duplicate, superseded by a
   * newer version, or safety-blocked — is removed from the outbox in every case: retrying an
   * identical payload can never change any of those verdicts. Only a genuine failure (the request
   * itself failing, or the server rejecting the payload's shape) stays queued, so the "pending N"
   * count reflects what still might succeed, not everything ever attempted.
   */
  async drainOutbox(): Promise<{ pushed: number; blocked: number }> {
    const { repository, api, apiBaseUrl, deviceToken } = this.deps;
    let pushed = 0;
    let blocked = 0;

    for (;;) {
      const pending = await repository.pendingSync();
      if (pending.length === 0) {
        break;
      }

      const batch = pending.slice(0, PUSH_BATCH_SIZE);
      const changes = batch.map((entry) => ({ table: entry.table, record: entry.payload }));
      this.log.debug('pushing batch', { batchSize: batch.length, pendingTotal: pending.length });

      const result = await api.pushChanges(apiBaseUrl, deviceToken, changes);
      if (!result.ok) {
        // A network/server failure, not a verdict on any individual record — every entry in this
        // batch stays queued for the next attempt.
        this.log.error('push failed', { error: result.error, code: result.code, batchSize: batch.length });
        for (const entry of batch) {
          await repository.markSyncFailed(entry.id!, result.error);
        }
        throw new SyncApiError(result.error, result.code);
      }

      for (const entry of batch) {
        const id = entry.id!;
        const applied = result.value.results.find((r) => r.id === entry.entityId);
        const wasBlocked = result.value.blocked.some((b) => b.id === entry.entityId);
        const wasRejected = result.value.rejected.some((r) => r.id === entry.entityId);

        if (applied) {
          await repository.markSynced(id);
          await markSyncedLocally(this.deps.store, entry.table, entry.entityId);
          pushed += 1;
        } else if (wasBlocked) {
          // Not a failure to retry — the safety warning broadcast is what surfaces this to every
          // caregiver in the household, not a stuck outbox entry.
          await repository.markSynced(id);
          blocked += 1;
        } else if (wasRejected) {
          await repository.markSyncFailed(id, 'The server rejected this record as invalid.');
        } else {
          // Shouldn't happen — every change sent is accounted for in one of the three arrays —
          // but leaving it queued is the fail-closed choice if it ever does.
          await repository.markSyncFailed(id, 'No result was reported for this change.');
        }
      }

      if (batch.length < PUSH_BATCH_SIZE) {
        break;
      }
    }

    this.log.debug('outbox drained', { pushed, blocked });
    return { pushed, blocked };
  }

  /**
   * Pulls everything written since this device's last known cursor (or a full bootstrap, the
   * first time), merging each record into the local database.
   */
  async pull(): Promise<void> {
    const { store, api, apiBaseUrl, deviceToken, householdId } = this.deps;
    const cursor = await getCursor(store, householdId);
    this.log.debug(cursor === undefined ? 'bootstrapping' : 'pulling delta', { cursor });

    const result =
      cursor === undefined
        ? await api.bootstrap(apiBaseUrl, deviceToken)
        : await api.pull(apiBaseUrl, deviceToken, cursor);

    if (!result.ok) {
      this.log.error('pull failed', { error: result.error, code: result.code, cursor });
      throw new SyncApiError(result.error, result.code);
    }

    for (const record of result.value.records) {
      await applyPulledRecord(store, record);
    }
    await setCursor(store, householdId, result.value.cursor);
    // Recorded on every successful pull, including one that returned nothing: "nothing changed"
    // is still contact with the household, and it is contact — not change — that tells a device
    // its local data is worth arming alarms from (safety invariant 6).
    await setLastSyncedAt(store, this.deps.repository.now());
    this.log.debug('pull applied', {
      records: result.value.records.length,
      newCursor: result.value.cursor,
      hasMore: result.value.hasMore ?? false,
    });

    if (result.value.hasMore) {
      await this.pull();
    }
  }

  /**
   * Push first, then pull — so this device's own just-applied changes don't round-trip as if remote.
   *
   * Both `SyncProvider`s call this from several independent triggers that can land in the same
   * tick — mount, a new outbox entry, and the live socket reaching `'open'` — so concurrent calls
   * are coalesced onto a single underlying run rather than allowed to overlap. Overlapping runs
   * both open a transaction via `store.transaction()`; Dexie/IndexedDB on web tolerates that, but
   * `apps/android`'s single `expo-sqlite` connection rejects a second `BEGIN` while one is already
   * open ("cannot start a transaction within a transaction"), which crashed sync outright.
   *
   * A call that arrives while a run is already in flight doesn't just join that run's promise —
   * the run in progress started before this call's trigger (e.g. a just-queued outbox entry)
   * existed, so it can't be trusted to have picked it up. Every such call instead joins one shared
   * "queued" rerun that starts right after the current run finishes, and only settles once that
   * rerun does — at most one extra run per busy period, however many callers arrived during it.
   */
  async runOnce(): Promise<void> {
    if (this.inFlight) {
      this.queued ??= this.inFlight.catch(() => {}).then(() => {
        this.queued = null;
        return this.runOnce();
      });
      return this.queued;
    }
    this.inFlight = this.runOnceExclusive().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runOnceExclusive(): Promise<void> {
    this.log.debug('sync run starting');
    await this.drainOutbox();
    await this.pull();
    this.log.debug('sync run finished');
  }
}
