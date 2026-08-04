import { bootstrap, pull as pullDelta, pushChanges } from '../api/syncApi.js';
import type { MedGuardDB } from '../db/schema.js';
import type { MedGuardRepository } from '../db/repository.js';
import { getCursor, setCursor } from './cursor.js';
import { applyPulledRecord, markSyncedLocally } from './tableDispatch.js';

/**
 * Drains the local outbox and pulls remote deltas — the two halves of local-first sync that,
 * before this sprint, nothing in the client actually did. A mutation would sit in `syncOutbox`
 * forever; nothing ever asked the server for what another caregiver's device had written.
 *
 * Deliberately framework-free: a plain class with async methods, so it is exactly as testable as
 * packages/shared's pure functions, and the React layer (a hook wrapping this) is a thin adapter
 * rather than where the logic lives.
 */

export interface SyncEngineDeps {
  db: MedGuardDB;
  repository: MedGuardRepository;
  apiBaseUrl: string;
  deviceToken: string;
  householdId: string;
}

/** Must stay at or under the server's own MAX_BATCH_SIZE (apps/api/src/routes/sync.ts). */
const PUSH_BATCH_SIZE = 200;

export class SyncEngine {
  constructor(private readonly deps: SyncEngineDeps) {}

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
    const { repository, apiBaseUrl, deviceToken } = this.deps;
    let pushed = 0;
    let blocked = 0;

    for (;;) {
      const pending = await repository.pendingSync();
      if (pending.length === 0) {
        break;
      }

      const batch = pending.slice(0, PUSH_BATCH_SIZE);
      const changes = batch.map((entry) => ({ table: entry.table, record: entry.payload }));

      const result = await pushChanges(apiBaseUrl, deviceToken, changes);
      if (!result.ok) {
        // A network/server failure, not a verdict on any individual record — every entry in this
        // batch stays queued for the next attempt.
        for (const entry of batch) {
          await repository.markSyncFailed(entry.id!, result.error);
        }
        throw new Error(result.error);
      }

      for (const entry of batch) {
        const id = entry.id!;
        const applied = result.value.results.find((r) => r.id === entry.entityId);
        const wasBlocked = result.value.blocked.some((b) => b.id === entry.entityId);
        const wasRejected = result.value.rejected.some((r) => r.id === entry.entityId);

        if (applied) {
          await repository.markSynced(id);
          await markSyncedLocally(this.deps.db, entry.table, entry.entityId);
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

    return { pushed, blocked };
  }

  /**
   * Pulls everything written since this device's last known cursor (or a full bootstrap, the
   * first time), merging each record into the local database.
   */
  async pull(): Promise<void> {
    const { db, apiBaseUrl, deviceToken, householdId } = this.deps;
    const cursor = await getCursor(db, householdId);

    const result =
      cursor === undefined
        ? await bootstrap(apiBaseUrl, deviceToken)
        : await pullDelta(apiBaseUrl, deviceToken, cursor);

    if (!result.ok) {
      throw new Error(result.error);
    }

    for (const record of result.value.records) {
      await applyPulledRecord(db, record);
    }
    await setCursor(db, householdId, result.value.cursor);

    if (result.value.hasMore) {
      await this.pull();
    }
  }

  /** Push first, then pull — so this device's own just-applied changes don't round-trip as if remote. */
  async runOnce(): Promise<void> {
    await this.drainOutbox();
    await this.pull();
  }
}
