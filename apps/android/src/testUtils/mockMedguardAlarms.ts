/**
 * Jest mock for `modules/medguard-alarms/src` (mapped in `jest.config.js`), so component tests
 * can render screens that import the native alarm module without a real device — the module
 * itself is verified separately (see `apps/android/README.md`, "Testing the exit gate on a real
 * device"). Every function resolves a harmless default; tests that care about a specific call
 * override it with `jest.spyOn`/`.mockResolvedValueOnce` on the imported module.
 */
export const scheduleDoseAlarm = jest.fn().mockResolvedValue(undefined);
export const cancelDoseAlarm = jest.fn().mockResolvedValue(undefined);
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
export const drainPendingActions = jest.fn().mockResolvedValue([]);
