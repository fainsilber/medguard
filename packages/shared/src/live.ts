import type { BlockReason } from './safety.js';
import type { UserId } from './types.js';

/**
 * The messages `HouseholdDO` broadcasts over its WebSocket fan-out.
 *
 * Deliberately thin: a `sync` message carries nothing but a cursor, telling a connected device
 * "something changed, go pull" rather than the changed record itself. The record still has to
 * come back through the ordinary pull path (validated, household-scoped, page-bounded) — the
 * socket is a doorbell, not a second copy of the sync protocol.
 */

export interface LiveSyncMessage {
  type: 'sync';
  /** The household's cursor as of the mutation that triggered this message. */
  cursor: number;
}

/**
 * Broadcast whenever a PRN dose push was not unconditionally safe — whether it was rejected
 * outright or accepted only because of an explicit override. Every caregiver in the household
 * sees this immediately, not just the device that attempted the dose (delta D2).
 */
export interface LiveSafetyWarningMessage {
  type: 'safety.warning';
  medicineId: string;
  blockedBy: BlockReason;
  attemptedByUserId: UserId;
  outcome: 'blocked' | 'overridden';
}

export type LiveMessage = LiveSyncMessage | LiveSafetyWarningMessage;
