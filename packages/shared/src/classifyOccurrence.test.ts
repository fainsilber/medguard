import { describe, expect, it } from 'vitest';
import { fromIso } from './clock.js';
import { DUE_NOW_WINDOW_MS, classifyOccurrence } from './classifyOccurrence.js';

const DUE_AT = '2026-06-15T08:00:00.000Z';
const DUE_MS = fromIso(DUE_AT);

describe('classifyOccurrence', () => {
  it('is done whenever a log exists, whatever the timing', () => {
    expect(classifyOccurrence(DUE_AT, DUE_MS - 60_000, true)).toBe('done');
    expect(classifyOccurrence(DUE_AT, DUE_MS + 60_000, true)).toBe('done');
  });

  it('is upcoming before the due time', () => {
    expect(classifyOccurrence(DUE_AT, DUE_MS - 1, false)).toBe('upcoming');
  });

  it('is due_now exactly at the due time', () => {
    expect(classifyOccurrence(DUE_AT, DUE_MS, false)).toBe('due_now');
  });

  it('is due_now for the whole grace window after the due time', () => {
    expect(classifyOccurrence(DUE_AT, DUE_MS + DUE_NOW_WINDOW_MS, false)).toBe('due_now');
  });

  it('is overdue one millisecond past the grace window', () => {
    expect(classifyOccurrence(DUE_AT, DUE_MS + DUE_NOW_WINDOW_MS + 1, false)).toBe('overdue');
  });

  it('stays overdue arbitrarily far past due', () => {
    expect(classifyOccurrence(DUE_AT, DUE_MS + 10 * 3_600_000, false)).toBe('overdue');
  });

  it('is snoozed while the snooze window has not elapsed', () => {
    const snoozedUntilMs = DUE_MS + 15 * 60_000;
    expect(classifyOccurrence(DUE_AT, DUE_MS + 5 * 60_000, false, snoozedUntilMs)).toBe('snoozed');
  });

  it('reverts to its ordinary classification once the snooze elapses', () => {
    const snoozedUntilMs = DUE_MS + 15 * 60_000;
    expect(classifyOccurrence(DUE_AT, snoozedUntilMs, false, snoozedUntilMs)).toBe('overdue');
    expect(classifyOccurrence(DUE_AT, snoozedUntilMs + 1, false, snoozedUntilMs)).toBe('overdue');
  });

  it('a log takes priority over an active snooze', () => {
    const snoozedUntilMs = DUE_MS + 15 * 60_000;
    expect(classifyOccurrence(DUE_AT, DUE_MS + 60_000, true, snoozedUntilMs)).toBe('done');
  });

  it('ignores an snoozedUntilMs that already elapsed', () => {
    const snoozedUntilMs = DUE_MS - 60_000;
    expect(classifyOccurrence(DUE_AT, DUE_MS, false, snoozedUntilMs)).toBe('due_now');
  });
});
