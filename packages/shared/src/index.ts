export { CLOCK_SKEW_TOLERANCE_MS, fromIso, isClockTrusted, toIso } from './clock.js';
export type { Clock, ClockTrust, EpochMs, IdGenerator, IsoInstant } from './clock.js';

export { systemClock, uuidIdGenerator } from './runtime/systemClock.js';

// Domain entities and validation
export { SINGLE_PATIENT_ID } from './types.js';
export type * from './types.js';
export * from './schemas.js';

// Time
export {
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  addLocalDays,
  formatLocalDate,
  formatLocalTime,
  localDayOfWeek,
  localDaysBetween,
  parseLocalDate,
  parseLocalTime,
  resolveLocal,
  zoneOffsetMs,
} from './timezone.js';
export type { LocalResolution } from './timezone.js';

// Intake history
export {
  administeredDoses,
  effectiveLogs,
  lastAdministeredDose,
  sortByActualTimeDesc,
} from './logs.js';

// Scheduling
export {
  activeSchedulesOn,
  closeSchedule,
  expandSchedule,
  expandSchedules,
  occurrenceKey,
  parseOccurrenceKey,
  reviseSchedule,
  scheduleAppliesOn,
  scheduleIsLiveOn,
} from './schedule.js';
export type { ExpansionRange, Occurrence, RevisionContext, ScheduleRevision } from './schedule.js';
export { DAY_LABELS, describeSchedule } from './scheduleDisplay.js';

// Today-view derivation (client-agnostic: web and Android both classify occurrences the same way)
export { DUE_NOW_WINDOW_MS, classifyOccurrence } from './classifyOccurrence.js';
export type { OccurrenceStatus } from './classifyOccurrence.js';
export { findLogForOccurrence } from './matchOccurrenceLog.js';
export { formatCountdown } from './formatCountdown.js';

// Shabbat mode (Sprint A5): reading the server-published windows. Zmanim themselves are computed
// only in the Worker (apps/api/src/shabbat/zmanim.ts) — nothing here imports @hebcal/core.
export {
  PRE_SHABBAT_ARMING_MS,
  activeWindow,
  nextWindow,
  shabbatModeAt,
  shabbatPhaseAt,
  upcomingWindows,
} from './shabbat.js';
export type { ShabbatPhase, ShabbatPhaseInput } from './shabbat.js';
export { describeShabbatWindow, formatShabbatDate } from './shabbatDisplay.js';
export type { ShabbatWindowDisplay } from './shabbatDisplay.js';

// Snooze (delta AD5): bounded, append-only deferral of a scheduled dose
export { MAX_SNOOZE_COUNT, buildDoseSnooze, deriveSnoozeState } from './snooze.js';
export type { SnoozeContext, SnoozeState } from './snooze.js';

// Household setting defaults, shared so two clients cannot bootstrap different safety windows
export {
  DEFAULT_CANDLE_LIGHTING_OFFSET_MINS,
  DEFAULT_CHIME_DURATION_SECONDS,
  DEFAULT_ESCALATION_MINUTES,
  DEFAULT_HAVDALAH,
  DEFAULT_SNOOZE_MINUTES,
  MISSED_AFTER_MINUTES,
} from './settings.js';

// PRN safety guards
export {
  ROLLING_WINDOW_MS,
  assessDose,
  blockReasonFor,
  dosesInRollingWindow,
  isDosePermitted,
} from './safety.js';
export type { AssessDoseInput, BlockReason, DoseSafety, LastDoseSummary } from './safety.js';

// Inventory ledger
export {
  adjustmentForLog,
  buildDoseAdjustment,
  buildManualAdjustment,
  buildReversalAdjustment,
  computeQuantity,
  daysOfSupply,
  deriveInventoryState,
  estimateDailyConsumption,
} from './inventory.js';
export type { AdjustmentContext, InventoryState, ManualAdjustmentInput } from './inventory.js';

// Sync
export { hasPendingChanges, isAppendOnlyTable, mergeCollections, mergeLww } from './sync.js';
export type { LwwRecord, MergeOutcome, MergeSource } from './sync.js';

// Real-time (WebSocket broadcast message shapes, shared by HouseholdDO and the client)
export type { LiveMessage, LiveSafetyWarningMessage, LiveSyncMessage } from './live.js';

// Export
export { buildIntakeLogCsv } from './export.js';

// Backup / restore
export {
  BACKUP_FORMAT_VERSION,
  backupBundleSchema,
  buildBackupBundle,
  parseBackupBundle,
  summarizeBackup,
} from './backup.js';
export type { BackupBundle, BackupSource, BackupSummary, ParseBackupResult } from './backup.js';

// App logging (in-memory, capped — see log.ts)
export { LogBuffer, formatLogEntriesAsText, formatLogEntry } from './log.js';
export type { LogEntry, LogLevel } from './log.js';

// Push (Sprint A4: the real dose/escalation/shabbat/low-stock contract)
export {
  PUSH_CHANNEL_IDS,
  PUSH_PAYLOAD_VERSION,
  SHABBAT_BURST_COUNT,
  SHABBAT_BURST_SPACING_MS,
  describePush,
  pushHasDoseActions,
} from './push.js';
export type {
  DosePushPayload,
  EscalationPushPayload,
  LowStockPushPayload,
  PushKind,
  PushPayload,
  ShabbatPushPayload,
} from './push.js';
