import { describe, expect, it } from 'vitest';
import { formatCountdown } from './countdown.js';

describe('formatCountdown', () => {
  it('formats hours and minutes together', () => {
    expect(formatCountdown(74 * 60_000)).toBe('1 hr 14 mins');
  });

  it('pluralises hours', () => {
    expect(formatCountdown(125 * 60_000)).toBe('2 hrs 5 mins');
  });

  it('omits hours entirely when there are none', () => {
    expect(formatCountdown(14 * 60_000)).toBe('14 mins');
  });

  it('omits minutes entirely when the remainder is exactly zero', () => {
    expect(formatCountdown(120 * 60_000)).toBe('2 hrs');
  });

  it('uses the singular for exactly one hour', () => {
    expect(formatCountdown(60 * 60_000)).toBe('1 hr');
  });

  it('uses the singular for exactly one minute', () => {
    expect(formatCountdown(60_000)).toBe('1 min');
  });

  it('rounds up a partial minute — 40 seconds must not read as "safe now"', () => {
    expect(formatCountdown(40_000)).toBe('1 min');
  });

  it('rounds up a partial minute even when hours are also present', () => {
    expect(formatCountdown(60 * 60_000 + 500)).toBe('1 hr 1 min');
  });

  it('falls back gracefully for a non-positive input, though assessDose never produces one', () => {
    expect(formatCountdown(0)).toBe('less than a minute');
    expect(formatCountdown(-1)).toBe('less than a minute');
  });
});
