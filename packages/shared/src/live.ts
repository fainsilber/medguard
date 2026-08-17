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
  /** Which patient the blocked/overridden dose was for — a shared medicine's cooldown is scoped
   * per patient, so the banner needs to say whose cooldown this was, not just which medicine. */
  patientId: string;
  blockedBy: BlockReason;
  attemptedByUserId: UserId;
  outcome: 'blocked' | 'overridden';
}

/**
 * Broadcast when a device tried to reconcile a Shabbat dose that another caregiver had already
 * settled (Sprint A5 phase 2).
 *
 * Its own message kind rather than a `safety.warning`: nothing unsafe happened. Two people opened
 * the Motzei sheet and both answered the same dose, the serialized write path accepted the first,
 * and the second device needs to say "Dad already recorded this" rather than showing a safety
 * banner for what is really a race between two people doing the right thing.
 */
export interface LiveReconciliationConflictMessage {
  type: 'reconciliation.conflict';
  /** `occurrenceKey` (`${scheduleId}:${dueAt}`) of the dose that was already settled. */
  occurrenceId: string;
  /** Who got there first, so the other sheet can name them. */
  reconciledByUserId: UserId;
  /** The device whose write was refused, so only that sheet has to react. */
  refusedDeviceId: string;
}

export type LiveMessage =
  | LiveSyncMessage
  | LiveSafetyWarningMessage
  | LiveReconciliationConflictMessage;
