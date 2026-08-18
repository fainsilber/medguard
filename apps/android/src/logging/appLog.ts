import { LogBuffer, formatLogEntriesAsText } from '@medguard/shared';
import type { LogEntry, LogLevel } from '@medguard/shared';
import { deviceClock } from '../runtime/deviceRuntime.js';

/**
 * The app-wide log, surfaced on the Settings screen — the Android equivalent of
 * `apps/web/src/logging/appLog.ts`.
 *
 * Unlike web's version, this file is not exempt from the no-ambient-time rule (`eslint.config.js`
 * scopes it to `apps/android/src/**` with only `runtime/**` exempt — see
 * `docs/android-client-plan.md`, "Framework and workspace"), so it takes its timestamp from
 * `deviceClock` rather than `new Date()`.
 *
 * Not persisted across a reload — it only needs to survive for the current session, which is
 * exactly the window in which "stuck" is still true.
 */

const buffer = new LogBuffer(500);
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function record(scope: string, level: LogLevel, message: string, data?: unknown): void {
  buffer.push({ timestamp: deviceClock.nowIso(), level, scope, message, data });
  if (level === 'warn' || level === 'error') {
    console[level](`[${scope}] ${message}`, data ?? '');
  }
  notify();
}

export interface ScopedLogger {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
}

/** A logger tagged with where it's called from, e.g. `appLog('sync')`. */
export function appLog(scope: string): ScopedLogger {
  return {
    debug: (message, data) => record(scope, 'debug', message, data),
    info: (message, data) => record(scope, 'info', message, data),
    warn: (message, data) => record(scope, 'warn', message, data),
    error: (message, data) => record(scope, 'error', message, data),
  };
}

export function getAppLogEntries(): readonly LogEntry[] {
  return buffer.entries();
}

export function clearAppLog(): void {
  buffer.clear();
  notify();
}

export function exportAppLogText(): string {
  return formatLogEntriesAsText(buffer.entries());
}

/** Lets the Settings screen re-render as new entries arrive, without polling. */
export function onAppLogChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
