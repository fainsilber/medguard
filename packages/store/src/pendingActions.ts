import {
  MS_PER_DAY,
  SINGLE_PATIENT_ID,
  buildDoseSnooze,
  deriveSnoozeState,
  expandSchedules,
  findLogForOccurrence,
  fromIso,
  occurrenceKey,
  parseOccurrenceKey,
  toIso,
} from '@medguard/shared';
import type { Clock, DoseSnooze, IdGenerator, IntakeLog, Occurrence } from '@medguard/shared';
import type { MedGuardRepository } from './repository.js';

/**
 * Turning a notification action a caregiver tapped into real domain state.
 *
 * The rule this exists to enforce is delta AD2: **the platform records intent, JavaScript records
 * the dose.** A lock-screen "Taken" tap must produce an `IntakeLog`, an inventory adjustment and
 * two outbox rows in one transaction — and there must be exactly one implementation of that,
 * because a second copy drifts from the first and a dose goes missing in the gap.
 *
 * Originally Android-only, inside `AlarmEngine`. Lifted here in Sprint A4 when the web client
 * gained the same lock-screen actions: a service worker cannot safely write the ledger either, so
 * it records intent to IndexedDB and the app drains it through this, exactly as Kotlin's
 * `pending_actions` table is drained through this. Cross-cutting rule 5 — safety logic is shared,
 * never duplicated — with the platforms differing only in where the intent was parked.
 */

export interface PendingActionEvent {
  /** An `occurrenceKey` — `${scheduleId}:${dueAt}`. */
  occurrenceKey: string;
  action: 'taken' | 'snooze';
  /** Epoch milliseconds at the instant the user tapped, never the instant this applies it. */
  tappedAtMs: number;
}

/**
 * A captured tap as it sits in platform storage, with the id its acknowledgement is keyed by.
 *
 * The id exists because reading and acknowledging are separate calls: the applier acks only after
 * the resulting record has actually committed, so a process killed mid-apply repeats a read
 * instead of losing a caregiver's tap (safety invariant 7).
 */
export interface PendingActionRecord extends PendingActionEvent {
  id: string;
}

/** Where captured taps live: Kotlin's `pending_actions` table, or the web's IndexedDB store. */
export interface PendingActionSource {
  readPendingActions(): Promise<PendingActionRecord[]>;
  ackPendingActions(ids: string[]): Promise<void>;
}

export interface PendingActionLog {
  debug(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const noopLog: PendingActionLog = { debug: () => {}, error: () => {} };

export interface PendingActionApplierDeps {
  repository: MedGuardRepository;
  source: PendingActionSource;
  clock: Clock;
  ids: IdGenerator;
  userId: string;
  deviceId: string;
  log?: PendingActionLog;
}

/**
 * How far back to look for snoozes. A snooze cannot defer a dose by more than
 * `MAX_SNOOZE_COUNT × snoozeMinutes` (an hour by default), so a day of history is generous by an
 * order of magnitude while still keeping the query bounded as snoozes accumulate over months.
 */
const SNOOZE_LOOKBACK_MS = MS_PER_DAY;

export class PendingActionApplier {
  private readonly log: PendingActionLog;
  private inFlight: Promise<number> | null = null;

  constructor(private readonly deps: PendingActionApplierDeps) {
    this.log = deps.log ?? noopLog;
  }

  /**
   * Converts every captured tap into a record, through the same `recordDose()` the UI calls.
   *
   * Two properties carry the weight here:
   *
   * 1. **Each action is acknowledged only after its record has committed.** A process killed
   *    mid-apply therefore repeats a read rather than dropping a caregiver's tap (invariant 7).
   * 2. **A dose already logged is skipped, not re-recorded.** `recordDose` is not idempotent — a
   *    second call for the same occurrence would mint a second inventory adjustment and
   *    double-decrement stock — and property 1 makes repeated reads normal, not exceptional.
   *
   * Coalesced, because callers trigger it from several independent places that can land within
   * milliseconds of each other: on Android, a cold launch from tapping a notification fires the
   * launch-time drain and the resulting foreground event together; on the web, a `message` from
   * the service worker arrives just as the page's own mount effect runs. Overlapping runs would
   * both read the same not-yet-acked entries and process them twice.
   */
  applyPendingActions(): Promise<number> {
    this.inFlight ??= this.applyExclusive().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async applyExclusive(): Promise<number> {
    const pending = await this.deps.source.readPendingActions();
    if (pending.length === 0) {
      return 0;
    }

    // Oldest tap first, so two taps on the same dose resolve in the order the caregiver made them.
    const ordered = [...pending].sort((a, b) => a.tappedAtMs - b.tappedAtMs);

    const applied: string[] = [];
    for (const action of ordered) {
      try {
        await this.applyOne(action);
        applied.push(action.id);
      } catch (error) {
        // Leave it un-acked and keep going: one unparseable or failing action must not block the
        // rest, and a genuinely broken one is retried on the next drain rather than lost.
        this.log.error('could not apply a captured notification action', {
          id: action.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (applied.length > 0) {
      await this.deps.source.ackPendingActions(applied);
    }

    this.log.debug('pending actions applied', { read: pending.length, applied: applied.length });
    return applied.length;
  }

  /** The Today screen's Snooze button — the same path a notification-action snooze takes. */
  snooze(key: string, atMs?: number): Promise<DoseSnooze | undefined> {
    return this.recordSnoozeFor(key, atMs ?? this.deps.clock.nowMs());
  }

  // -------------------------------------------------------------------------

  private async applyOne(action: PendingActionRecord): Promise<void> {
    if (action.action === 'snooze') {
      await this.recordSnoozeFor(action.occurrenceKey, action.tappedAtMs);
      return;
    }

    const { repository, ids, userId, deviceId } = this.deps;
    const occurrence = await this.resolveOccurrence(action.occurrenceKey);
    if (!occurrence) {
      // A schedule revised or stopped between the tap and the drain. Nothing to log against, and
      // inventing an occurrence would be worse than dropping the tap.
      this.log.error('no occurrence for a captured action', {
        occurrenceKey: action.occurrenceKey,
      });
      return;
    }

    const logs = await repository.logsForPatient(SINGLE_PATIENT_ID);
    if (findLogForOccurrence(logs, occurrence) !== undefined) {
      // Already recorded — by the UI, by another device's sync, or by a previous drain that
      // committed and then died before acknowledging. Skipping is what makes the retry safe.
      this.log.debug('skipping an already-logged occurrence', {
        occurrenceKey: action.occurrenceKey,
      });
      return;
    }

    const log: IntakeLog = {
      id: ids.next(),
      patientId: occurrence.patientId,
      medicineId: occurrence.medicineId,
      scheduleId: occurrence.scheduleId,
      type: 'scheduled',
      status: 'taken',
      scheduledTime: occurrence.dueAt,
      // The tap instant, never the drain instant: `actualTime` starts the rolling-24h cap window,
      // so recording the wrong moment misstates both the history and the safety arithmetic.
      actualTime: toIso(action.tappedAtMs),
      quantityTaken: occurrence.dosageQuantity,
      loggedByUserId: userId,
      loggedByDeviceId: deviceId,
      syncStatus: 'pending',
    };

    await repository.recordDose(log);
  }

  private async recordSnoozeFor(key: string, atMs: number): Promise<DoseSnooze | undefined> {
    // Same well-formedness check the server's `occurrenceKeySchema` enforces on `doseSnoozes`
    // pushes — deliberately just "parses as scheduleId:dueAt", not "the schedule still exists"
    // (unlike `resolveOccurrence`), since a snooze recorded a moment before a schedule was edited
    // is still a legitimate historical fact. Without this, a garbage key reaches `recordSnooze()`
    // unchecked, and the resulting record fails the server's schema forever: it lands in the
    // outbox and the whole batch keeps re-failing on every retry.
    if (parseOccurrenceKey(key) === undefined) {
      this.log.error('refusing to snooze — not a real occurrence key', { occurrenceKey: key });
      return undefined;
    }

    const { repository, clock, ids, userId, deviceId } = this.deps;

    const settings = await repository.getHouseholdSettings();
    if (!settings) {
      return undefined;
    }

    const existing = await repository.snoozesForOccurrence(key);
    const state = deriveSnoozeState(existing, key);
    if (!state.canSnooze) {
      // The bound is reached. Deliberately silent rather than an error: the occurrence simply
      // stays overdue and keeps ringing, which is the fail-closed direction for a missed dose.
      this.log.debug('snooze refused — bound reached', { occurrenceKey: key, count: state.count });
      return undefined;
    }

    return repository.recordSnooze(
      buildDoseSnooze(
        key,
        settings.snoozeMinutes,
        state.count,
        { clock, ids, userId, deviceId },
        atMs,
      ),
    );
  }

  /**
   * Rebuilds the `Occurrence` behind an `occurrenceKey`, by re-expanding just its schedule across
   * the day the dose was due.
   *
   * The key carries only the schedule id and the instant, but `recordDose` needs the patient,
   * medicine and dosage too — and re-deriving them through `expandSchedules` rather than reading
   * them off the schedule row directly means a dose recorded from a notification goes through the
   * exact same DST-aware expansion as one recorded in the UI.
   */
  private async resolveOccurrence(key: string): Promise<Occurrence | undefined> {
    const parsed = parseOccurrenceKey(key);
    if (!parsed) {
      return undefined;
    }

    const { repository } = this.deps;
    const settings = await repository.getHouseholdSettings();
    if (!settings) {
      return undefined;
    }

    const schedules = await repository.allSchedules();
    const schedule = schedules.find((candidate) => candidate.id === parsed.scheduleId);
    if (!schedule) {
      return undefined;
    }

    const dueMs = fromIso(parsed.dueAt);
    const occurrences = expandSchedules(
      [schedule],
      { fromMs: dueMs - MS_PER_DAY, toMs: dueMs + MS_PER_DAY },
      settings.timeZone,
    );

    return occurrences.find((occurrence) => occurrenceKey(occurrence) === key);
  }

  /** Exposed for callers that need the same lookback window when reading snoozes themselves. */
  static readonly SNOOZE_LOOKBACK_MS = SNOOZE_LOOKBACK_MS;
}
