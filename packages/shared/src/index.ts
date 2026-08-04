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
  reviseSchedule,
  scheduleAppliesOn,
  scheduleIsLiveOn,
} from './schedule.js';
export type { ExpansionRange, Occurrence, RevisionContext, ScheduleRevision } from './schedule.js';

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
export { hasPendingChanges, mergeCollections, mergeLww } from './sync.js';
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

// Push (Sprint 0 probe contract; superseded by the real push routes in Sprint 5)
export { SHABBAT_BURST_COUNT, SHABBAT_BURST_SPACING_MS } from './push.js';
export type {
  ProbeNotificationOptions,
  ProbePushLog,
  ProbePushPayload,
  ProbePushReceipt,
  ProbeSendRecord,
} from './push.js';
