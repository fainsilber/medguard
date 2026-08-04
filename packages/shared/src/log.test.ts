import { describe, expect, it } from 'vitest';
import { LogBuffer, formatLogEntriesAsText, formatLogEntry } from './log.js';
import type { LogEntry } from './log.js';

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: '2026-08-04T12:00:00.000Z',
    level: 'info',
    scope: 'sync',
    message: 'pull complete',
    ...overrides,
  };
}

describe('LogBuffer', () => {
  it('returns entries in the order they were pushed', () => {
    const buffer = new LogBuffer();
    buffer.push(entry({ message: 'first' }));
    buffer.push(entry({ message: 'second' }));

    expect(buffer.entries().map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('drops the oldest entry once the cap is reached, keeping the buffer bounded', () => {
    const buffer = new LogBuffer(2);
    buffer.push(entry({ message: 'first' }));
    buffer.push(entry({ message: 'second' }));
    buffer.push(entry({ message: 'third' }));

    expect(buffer.entries().map((e) => e.message)).toEqual(['second', 'third']);
  });

  it('empties on clear', () => {
    const buffer = new LogBuffer();
    buffer.push(entry());
    buffer.clear();

    expect(buffer.entries()).toEqual([]);
  });
});

describe('formatLogEntry', () => {
  it('renders timestamp, level, scope and message', () => {
    const text = formatLogEntry(entry());
    expect(text).toBe('[2026-08-04T12:00:00.000Z] INFO  sync: pull complete');
  });

  it('appends JSON-serialized data when present', () => {
    const text = formatLogEntry(entry({ data: { pushed: 3, blocked: 0 } }));
    expect(text).toBe('[2026-08-04T12:00:00.000Z] INFO  sync: pull complete {"pushed":3,"blocked":0}');
  });

  it('falls back to a placeholder when data cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const text = formatLogEntry(entry({ data: circular }));
    expect(text).toContain('[unserializable data]');
  });
});

describe('formatLogEntriesAsText', () => {
  it('joins every entry on its own line', () => {
    const text = formatLogEntriesAsText([
      entry({ message: 'first' }),
      entry({ message: 'second', level: 'error' }),
    ]);
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('first');
    expect(text).toContain('ERROR sync: second');
  });

  it('returns an empty string for no entries', () => {
    expect(formatLogEntriesAsText([])).toBe('');
  });
});
