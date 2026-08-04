/**
 * A capped, in-memory event log — platform-agnostic so both the client and (if ever needed) the
 * worker can record "what actually happened" around sync, without pulling in a logging library.
 *
 * Deliberately takes an already-stamped `timestamp` on every entry rather than reading the clock
 * itself: this module lives under `packages/shared/src/**`, which the no-ambient-time lint rule
 * covers, and the caller (an adapter with its own clock) is where "now" belongs.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

const DEFAULT_MAX_ENTRIES = 500;

/**
 * A ring buffer: once full, the oldest entry is dropped to make room for the newest. Bounded so a
 * long-running session (a phone left open for days) can't grow this without limit.
 */
export class LogBuffer {
  private readonly items: LogEntry[] = [];

  constructor(private readonly maxEntries: number = DEFAULT_MAX_ENTRIES) {}

  push(entry: LogEntry): void {
    this.items.push(entry);
    if (this.items.length > this.maxEntries) {
      this.items.shift();
    }
  }

  /**
   * A snapshot copy, not a live view — callers (notably React state) rely on getting a new array
   * identity each time so a mutation to the underlying buffer is actually observed as a change.
   */
  entries(): readonly LogEntry[] {
    return [...this.items];
  }

  clear(): void {
    this.items.length = 0;
  }
}

function formatLogData(data: unknown): string | null {
  if (data === undefined) {
    return null;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return '[unserializable data]';
  }
}

export function formatLogEntry(entry: LogEntry): string {
  const base = `[${entry.timestamp}] ${entry.level.toUpperCase().padEnd(5)} ${entry.scope}: ${entry.message}`;
  const data = formatLogData(entry.data);
  return data === null ? base : `${base} ${data}`;
}

export function formatLogEntriesAsText(entries: readonly LogEntry[]): string {
  return entries.map(formatLogEntry).join('\n');
}
