import { LogBuffer, formatLogEntriesAsText } from '@medguard/shared';
import type { LogEntry, LogLevel } from '@medguard/shared';

/**
 * The app-wide log, exported from the Diagnostics screen.
 *
 * This exists because "stuck in Syncing…" (or any other silent hang) is otherwise undiagnosable
 * once it's happened — nothing survives long enough to inspect, and a caregiver reporting the bug
 * has no way to hand over more than a screenshot. Every meaningful step the sync engine and live
 * connection take gets recorded here, in order, so a caregiver can export the log and attach it to
 * a bug report instead of us guessing from a photo of a badge.
 *
 * Not persisted across a reload — it only needs to survive for the current session, which is
 * exactly the window in which "stuck" is still true. `new Date()` is fine here despite the rest of
 * the app's no-ambient-time rule: this file lives outside every glob that rule covers, precisely so
 * that ambient time stays confined to this one adapter instead of leaking into `sync/*.ts`.
 */

const buffer = new LogBuffer(500);
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function record(scope: string, level: LogLevel, message: string, data?: unknown): void {
  buffer.push({ timestamp: new Date().toISOString(), level, scope, message, data });
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

/** Lets the Diagnostics screen re-render as new entries arrive, without polling. */
export function onAppLogChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
