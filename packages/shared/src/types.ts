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
 * The one patient every record belongs to. The schema carries `patientId` on every entity so
 * multi-patient support is a UI change later rather than a migration, but the UI ships single-
 * patient in v1 (see sprint plan assumptions) — everything just uses this constant for now.
 *
 * A real (if arbitrary) UUID rather than a human-readable placeholder like `"patient-1"`,
 * because `patientId` fields are validated as UUIDs — using a non-UUID placeholder now would
 * mean every local record silently fails that validation the moment Sprint 3 starts enforcing
 * it at the sync boundary.
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
}

// ---------------------------------------------------------------------------
// Medicines
// ---------------------------------------------------------------------------

export type MedicineForm = 'pill' | 'liquid' | 'injection' | 'topical' | 'other';

export interface Medicine extends Syncable {
  id: Uuid;
  patientId: Uuid;
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
  /** Minimum interval between doses. Only meaningful when `asNeeded` is true. */
  minHoursBetweenDoses?: number;
  /** Rolling-24h dose cap. Only meaningful when `asNeeded` is true. */
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
  /** Target span of the alert burst. See SHABBAT_BURST_* in push.ts. */
  chimeDurationSeconds: number;
}

// ---------------------------------------------------------------------------
// Sync outbox
// ---------------------------------------------------------------------------

export type SyncableTable =
  | 'medicines'
  | 'schedules'
  | 'intakeLogs'
  | 'inventoryItems'
  | 'inventoryAdjustments'
  | 'shabbatConfig'
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
