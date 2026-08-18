import type { IsoInstant } from './clock.js';

/**
 * Domain entities, per PRD §5 and amended for the deltas recorded in the sprint plan.
 *
 * Everything here is pure data — no methods, no framework types — so the same definitions
 * compile in the browser, in workerd, and in a future native client.
 */

export type Uuid = string;
export type DeviceId = string;
export type UserId = string;

/** `YYYY-MM-DD` in the household's fixed timezone. Not an instant — a calendar date. */
export type LocalDate = string;

/** `HH:MM` wall-clock in the household's fixed timezone. Not an instant — a time of day. */
export type LocalTime = string;

export type SyncStatus = 'synced' | 'pending';

/**
 * The patient id every pre-multi-patient household record was minted against. Multi-patient
 * households now have a real `patients` table (below), but this constant lives on as the id the
 * server backfill assigns to a household's first, auto-created patient — so a household that
 * synced before multi-patient shipped resolves to the same patient id it always had, and a device
 * mid-upgrade never disagrees with the server about which patient a not-yet-renamed record
 * belongs to.
 */
export const SINGLE_PATIENT_ID: Uuid = '00000000-0000-4000-8000-000000000001';

/**
 * Fields every locally-mutable, server-synced record carries.
 *
 * `updatedByDeviceId` exists purely to break Last-Write-Wins ties deterministically: two devices
 * can write the same millisecond, and "whichever arrived last" is not reproducible. See sync.ts.
 */
export interface Syncable {
  updatedAt: IsoInstant;
  updatedByDeviceId: DeviceId;
  syncStatus: SyncStatus;
}

// ---------------------------------------------------------------------------
// Household settings
// ---------------------------------------------------------------------------

/**
 * One row. The household timezone is fixed here rather than read from the device, so a caregiver
 * travelling across timezones doesn't silently shift every dose time (PRD §1).
 */
export interface HouseholdSettings extends Syncable {
  id: 'household';
  /** IANA zone, e.g. `Asia/Jerusalem`. Every LocalDate/LocalTime in the system resolves against this. */
  timeZone: string;
  /** Minutes an unacknowledged scheduled dose waits before escalating (PRD §4). */
  escalationAfterMinutes: number;
  /** Minutes a snooze defers a dose by. */
  snoozeMinutes: number;
  /**
   * How many times a caregiver may snooze one scheduled dose before the escalation window takes
   * over rather than the snooze button. Optional because every household created before this
   * setting existed has a stored record without it — `resolveMaxSnoozeCount()` (`snooze.ts`)
   * supplies the default (`MAX_SNOOZE_COUNT`, 3) and clamps into `MIN_SNOOZE_LIMIT..MAX_SNOOZE_LIMIT`.
   */
  maxSnoozeCount?: number;
}

// ---------------------------------------------------------------------------
// Patients
// ---------------------------------------------------------------------------

/**
 * One member of the household whose medicines are tracked — a child, a sibling, a parent.
 *
 * Every household that ever recorded a medicine has at least one patient: the server backfill
 * (migration `0005_patients.sql`) creates one named "Patient" with id `SINGLE_PATIENT_ID` for any
 * household with existing medicines, so caregivers upgrading from a single-patient household land
 * on a rename rather than a re-entry.
 */
export interface Patient extends Syncable {
  id: Uuid;
  /** e.g. "Yoni", "Mom" — the only piece of a person's name this app ever stores. */
  displayName: string;
  /**
   * Archived, never deleted: intake logs and medicines reference a patient forever, and a deleted
   * patient would orphan that history (safety invariant 1) the same way a deleted medicine would.
   */
  archived: boolean;
  /** Manual ordering for the patient switcher, so the list isn't alphabetically arbitrary. */
  sortOrder: number;
}

/**
 * One patient's entitlement to take one medicine. A medicine with no rows here belongs to nobody
 * yet; one row makes it private to that patient; several rows make it shared.
 *
 * `id` is deterministic (`${medicineId}:${patientId}`, see `medicinePatientId()`) rather than a
 * random UUID, so two devices assigning the same pair while offline converge on one row instead of
 * duplicating it — the same trick `ShabbatWindow.id` uses to make republishing idempotent.
 */
export interface MedicinePatient extends Syncable {
  id: string;
  medicineId: Uuid;
  patientId: Uuid;
  /**
   * Unassignment is a soft delete, for the same reason medicines archive rather than disappear:
   * an intake log logged while a medicine was assigned to a patient must still resolve that
   * assignment when read back later, even after a caregiver removes it.
   */
  active: boolean;
}

/** The deterministic id for a `MedicinePatient` row — see the doc comment on the type. */
export function medicinePatientId(medicineId: Uuid, patientId: Uuid): string {
  return `${medicineId}:${patientId}`;
}

// ---------------------------------------------------------------------------
// Medicines
// ---------------------------------------------------------------------------

export type MedicineForm = 'pill' | 'liquid' | 'injection' | 'topical' | 'other';

export interface Medicine extends Syncable {
  id: Uuid;
  /**
   * Vestigial as of multi-patient support: who takes a medicine is now expressed by
   * `MedicinePatient` rows, which support one, several, or (implicitly, via an "all patients"
   * assignment) every patient. Optional so records written before that change keep validating;
   * new code should not read or write it. Kept rather than removed because the server's D1 column
   * is `NOT NULL` and SQLite cannot relax that in place without a table rebuild.
   */
  patientId?: Uuid;
  name: string;
  /** Free text as printed on the label, e.g. "50mg". Never parsed — the app does not do dose math. */
  strength: string;
  form: MedicineForm;
  /**
   * Taken as needed rather than on a fixed schedule (clinically "PRN", pro re nata). An explicit
   * choice, not inferred from the absence of a schedule — a scheduled medicine whose schedule was
   * just stopped isn't suddenly "as needed" until a caregiver says so.
   */
  asNeeded: boolean;
  /**
   * Minimum interval between doses. Only meaningful when `asNeeded` is true. Applies to whoever
   * takes the medicine — a shared medicine has one cooldown, not one per patient (see
   * `AssessDoseInput` in `safety.ts` for how per-patient *counting* still works within that shared
   * limit).
   */
  minHoursBetweenDoses?: number;
  /** Rolling-24h dose cap. Only meaningful when `asNeeded` is true. Same shared-limit note as above. */
  maxDailyDoses?: number;
  instructions?: string;
  /**
   * Archived, never deleted: intake logs reference medicines forever, and a deleted medicine
   * would orphan a patient's dosing history (safety invariant 1).
   */
  archived: boolean;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export type FrequencyType = 'daily' | 'interval_days' | 'specific_days';

/**
 * A scheduled regimen.
 *
 * Alternating regimens (PRD §2.2 — 50mg Mon/Wed/Fri, 25mg Tue/Thu/Sat) are modelled as two
 * schedules sharing a `regimenGroupId`, because `dosageQuantity` is a single value (delta D6).
 * The UI presents a group as one regimen.
 *
 * Editing a schedule never mutates it in place: the old version is closed (`active: false`,
 * `endDate` set) and a new one created with `supersedesId` pointing back, so past occurrences
 * and the logs that reference them are never rewritten.
 */
export interface Schedule extends Syncable {
  id: Uuid;
  medicineId: Uuid;
  patientId: Uuid;
  frequencyType: FrequencyType;
  /** Required when frequencyType is `interval_days`. Every N days from startDate. */
  intervalDays?: number;
  /** Required when frequencyType is `specific_days`. 0 = Sunday … 6 = Saturday. */
  daysOfWeek?: number[];
  /** Wall-clock times in the household timezone, e.g. `["08:00", "20:00"]`. */
  timesOfDay: LocalTime[];
  dosageQuantity: number;
  startDate: LocalDate;
  /** Inclusive last day. Absent means open-ended. Set when a schedule version is closed. */
  endDate?: LocalDate;
  active: boolean;
  /** Links the halves of an alternating regimen (delta D6). */
  regimenGroupId?: Uuid;
  /** The schedule version this one replaced. */
  supersedesId?: Uuid;
}

// ---------------------------------------------------------------------------
// Intake logs
// ---------------------------------------------------------------------------

export type IntakeType = 'scheduled' | 'prn';
export type IntakeStatus = 'taken' | 'skipped' | 'missed' | 'pending_shabbat';

/**
 * Recorded when a caregiver deliberately administers a dose the safety rules blocked.
 *
 * Its presence is the audit trail required by safety invariant 5 — an override is never
 * anonymous and never silent.
 */
export interface DoseOverride {
  confirmedByUserId: UserId;
  /** Free-text reason, required by the double-confirm flow. */
  reason: string;
  /** What the safety engine objected to at the moment of override. */
  blockedBy: 'cooldown' | 'daily_cap' | 'untrusted_clock';
}

/**
 * Append-only (safety invariant 1). A correction never edits or deletes: it writes a *new* log
 * whose `supersedesId` names the mistaken one, so the original stays visible in history.
 */
export interface IntakeLog {
  id: Uuid;
  patientId: Uuid;
  medicineId: Uuid;
  /** Absent for PRN doses. */
  scheduleId?: Uuid;
  type: IntakeType;
  status: IntakeStatus;
  /** When the dose was due. Absent for PRN. */
  scheduledTime?: IsoInstant;
  /** When it was actually given. This is what cooldown and cap arithmetic use. */
  actualTime: IsoInstant;
  quantityTaken: number;
  loggedByUserId: UserId;
  loggedByDeviceId: DeviceId;
  notes?: string;
  /** Present only when the caregiver overrode a safety block. */
  override?: DoseOverride;
  /** The earlier log this one corrects. */
  supersedesId?: Uuid;
  syncStatus: SyncStatus;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type InventoryAdjustmentReason =
  | 'initial'
  | 'dose'
  | 'refill'
  | 'correction'
  /** Dropped, spilled, expired. */
  | 'lost';

/**
 * Append-only ledger entry.
 *
 * Stock is the sum of these, never a mutable counter: two caregivers logging a dose offline
 * would each write `currentQuantity = n - 1` and Last-Write-Wins would silently discard one
 * decrement, drifting the count and corrupting refill alerts.
 */
export interface InventoryAdjustment {
  id: Uuid;
  medicineId: Uuid;
  /** Negative consumes stock, positive adds it. */
  delta: number;
  reason: InventoryAdjustmentReason;
  /** The intake log that caused this, when reason is `dose`. Lets a correction reverse it. */
  relatedLogId?: Uuid;
  createdAt: IsoInstant;
  createdByUserId: UserId;
  createdByDeviceId: DeviceId;
  note?: string;
  syncStatus: SyncStatus;
}

/** The mutable, LWW-safe part of inventory. The quantity itself is derived from the ledger. */
export interface InventoryItem extends Syncable {
  id: Uuid;
  medicineId: Uuid;
  refillThreshold: number;
  /** e.g. "pills", "ml". Display only — never used in arithmetic. */
  unitName: string;
  lastRefilledAt?: IsoInstant;
}

// ---------------------------------------------------------------------------
// Snooze
// ---------------------------------------------------------------------------

/**
 * One caregiver deferring one scheduled dose (delta AD5).
 *
 * Append-only, not a mutable `snoozedUntil` field, for the same reason inventory is a ledger:
 * two caregivers snoozing the same dose while offline would each write a deadline and
 * Last-Write-Wins would silently discard one. It also makes the bound trivially correct — the
 * number of snoozes granted *is* the row count, with nothing to increment and get wrong.
 *
 * Being a synced fact rather than local UI state is what lets the server stop an escalation when
 * any device snoozes: `applyBatch` already sees every synced record, so no new channel is needed.
 */
export interface DoseSnooze {
  id: Uuid;
  /** An `occurrenceKey` — `${scheduleId}:${dueAt}`. See `occurrenceKey` in schedule.ts. */
  occurrenceId: string;
  /** How long this snooze defers the dose by, captured at creation so a later settings change
   * cannot retroactively move a deadline that already passed. */
  minutes: number;
  /** 1-based ordinal of this snooze for its occurrence, as counted when it was created. */
  count: number;
  createdAt: IsoInstant;
  createdByUserId: UserId;
  createdByDeviceId: DeviceId;
  syncStatus: SyncStatus;
}

// ---------------------------------------------------------------------------
// Shabbat
// ---------------------------------------------------------------------------

export interface ShabbatConfig extends Syncable {
  id: Uuid;
  patientId: Uuid;
  autoShabbatEnabled: boolean;
  latitude: number;
  longitude: number;
  /** Minutes before sunset. Default 18. */
  candleLightingOffsetMins: number;
  /** e.g. `"8.5_degrees"` or `"50_mins"`. */
  havdalahDegreesOrMins: string;
  /**
   * Israel observes one day of Yom Tov, the diaspora two (delta D4). Without this, chag handling
   * is wrong for half the year.
   */
  israelHolidays: boolean;
  /**
   * How long a dose alert rings **on Shabbat and Yom Tov** before stopping on its own. Default 30.
   *
   * Both alert lengths live on this record because it is the one the Shabbat screen already edits
   * and saves atomically, and because until this field was split in two it was a single
   * `chimeDurationSeconds` that the Android horizon read for weekday alarms as well. Resolve it
   * through `chimeDurationSecondsFor()` rather than reading it directly — that is what applies the
   * defaults and the clamp.
   */
  chimeDurationSeconds: number;
  /**
   * How long a dose alert rings on an ordinary weekday. Default 60.
   *
   * Optional because every household created before the split has a stored config without it, and
   * a record that fails validation is a device that stops syncing. `chimeDurationSecondsFor()`
   * supplies the default.
   */
  weekdayChimeDurationSeconds?: number;
}

/**
 * Whether a window is Shabbat, a Yom Tov, or the two run together.
 *
 * `combined` is not cosmetic: a chag adjacent to Shabbat is one continuous 72-hour period during
 * which nothing may be written, and the whole reason windows are computed as spans rather than
 * per-day is that this case must not appear as two windows with a gap between them.
 */
export type ShabbatWindowKind = 'shabbat' | 'yom_tov' | 'combined';

/**
 * One continuous period during which the app is in Shabbat mode.
 *
 * **Server-authored.** The Worker computes these from `ShabbatConfig` with `@hebcal/core` (PRD §3)
 * and publishes them like any other synced record; devices only ever read them. A client cannot
 * write one — `apps/api/src/routes/sync.ts` rejects the attempt — because a device that could
 * mint its own windows could talk itself into or out of Shabbat mode.
 *
 * Devices hold them so that entering mode needs no network: a phone that last synced on Thursday
 * still knows exactly when Shabbat starts, which is the same reason dose occurrences are expanded
 * locally rather than fetched.
 */
export interface ShabbatWindow extends Syncable {
  /**
   * `shabbat:<startsAt>` — derived from the window itself rather than random, so recomputing the
   * same window produces the same record instead of a duplicate. Republishing is therefore
   * idempotent, which is what lets the server regenerate the horizon as often as it likes.
   */
  id: string;
  patientId: Uuid;
  kind: ShabbatWindowKind;
  /** What it is, for the verification screen: "Shabbat", "Rosh Hashana", "Shabbat · Sukkot". */
  label: string;
  /** Candle lighting: sunset on erev, minus `candleLightingOffsetMins`. */
  startsAt: IsoInstant;
  /** Havdalah, per `havdalahDegreesOrMins`. */
  endsAt: IsoInstant;
  /**
   * When the server computed this window, and therefore how old the calculation is. A caregiver
   * checking times against a luach needs to know whether they are looking at a window computed
   * before or after they last changed the coordinates.
   */
  generatedAt: IsoInstant;
}

// ---------------------------------------------------------------------------
// Sync outbox
// ---------------------------------------------------------------------------

export type SyncableTable =
  | 'patients'
  | 'medicinePatients'
  | 'medicines'
  | 'schedules'
  | 'intakeLogs'
  | 'inventoryItems'
  | 'inventoryAdjustments'
  | 'doseSnoozes'
  | 'shabbatConfig'
  | 'shabbatWindows'
  | 'householdSettings';

export type SyncAction = 'CREATE' | 'UPDATE' | 'DELETE';

/**
 * A pending local mutation awaiting upload.
 *
 * Written in the same Dexie transaction as the mutation it describes, so a failure can never
 * leave a change that will not sync, or an outbox row for a change that never happened.
 */
export interface SyncOutboxEntry {
  /** Auto-incremented locally; absent until Dexie assigns it. */
  id?: number;
  table: SyncableTable;
  entityId: string;
  action: SyncAction;
  payload: unknown;
  createdAt: IsoInstant;
  /** Retry bookkeeping, surfaced in the UI so a stuck queue is visible (safety invariant 6). */
  attempts: number;
  lastError?: string;
  lastAttemptAt?: IsoInstant;
}
