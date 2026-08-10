/**
 * Jest mock for `modules/medguard-alarms/src` (mapped in `jest.config.js`), so component tests
 * can render screens that import the native alarm module without a real device — the module
 * itself is verified separately (see `apps/android/README.md`, "Testing the exit gate on a real
 * device"). Every function resolves a harmless default; tests that care about a specific call
 * override it with `jest.spyOn`/`.mockResolvedValueOnce` on the imported module.
 */
export const scheduleDoseAlarm = jest.fn().mockResolvedValue(undefined);
export const armDoseAlarms = jest.fn().mockResolvedValue(undefined);
export const cancelDoseAlarm = jest.fn().mockResolvedValue(undefined);
export const cancelAllDoseAlarms = jest.fn().mockResolvedValue(undefined);
export const listArmedAlarms = jest.fn().mockResolvedValue([]);
export const showStatusNotification = jest.fn().mockResolvedValue(undefined);
export const clearStatusNotification = jest.fn().mockResolvedValue(undefined);
/** Returns a no-op subscription so a component's cleanup path works without a real event bus. */
export const addPendingActionListener = jest.fn().mockReturnValue({ remove: jest.fn() });
export const playTestChime = jest.fn().mockResolvedValue(undefined);
export const canScheduleExactAlarms = jest.fn().mockResolvedValue(true);
export const requestScheduleExactAlarm = jest.fn().mockResolvedValue(undefined);
export const hasNotificationPermission = jest.fn().mockResolvedValue(true);
export const requestNotificationPermission = jest.fn().mockResolvedValue(true);
export const canUseFullScreenIntent = jest.fn().mockResolvedValue(true);
export const isIgnoringBatteryOptimizations = jest.fn().mockResolvedValue(true);
export const requestIgnoreBatteryOptimizations = jest.fn().mockResolvedValue(undefined);
export const hasNotificationPolicyAccess = jest.fn().mockResolvedValue(true);
export const requestNotificationPolicyAccess = jest.fn().mockResolvedValue(undefined);
export const readPendingActions = jest.fn().mockResolvedValue([]);
export const ackPendingActions = jest.fn().mockResolvedValue(undefined);
// A fixed default is enough: `localClockGuard.ts`'s drift math only compares this against its own
// anchor from a prior call, both taken microseconds apart within a single fast test run, so a
// static value (like every other mock in this file) stays well inside tolerance without reaching
// for ambient time here, which this file — unlike `apps/android/src/clock/**` — isn't exempt from.
export const elapsedRealtimeMs = jest.fn().mockResolvedValue(0);
/**
 * Sprint A4. Null by default, matching a build with no `google-services.json` — the state the
 * sideloadable APK is actually in, and the one whose degradation path is worth exercising by
 * default rather than by exception.
 */
export const getPushToken = jest.fn().mockResolvedValue(null);
export const addPushTokenListener = jest.fn().mockReturnValue({ remove: jest.fn() });
