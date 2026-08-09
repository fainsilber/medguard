import { describe, expect, it } from 'vitest';

import { fixedClock, sequentialIds } from './testing.js';
import { DEFAULT_ESCALATION_MINUTES, DEFAULT_SNOOZE_MINUTES } from './settings.js';
import { MAX_SNOOZE_COUNT, buildDoseSnooze, deriveSnoozeState } from './snooze.js';
import type { DoseSnooze } from './types.js';

const OCCURRENCE = '11111111-1111-4111-8111-111111111111:2026-06-15T08:00:00.000Z';
const OTHER_OCCURRENCE = '22222222-2222-4222-8222-222222222222:2026-06-15T08:00:00.000Z';

function makeSnooze(overrides: Partial<DoseSnooze> = {}): DoseSnooze {
  return {
    id: 'snooze-1',
    occurrenceId: OCCURRENCE,
    minutes: 20,
    count: 1,
    createdAt: '2026-06-15T08:05:00.000Z',
    createdByUserId: 'mom',
    createdByDeviceId: 'device-1',
    syncStatus: 'pending',
    ...overrides,
  };
}

describe('deriveSnoozeState', () => {
  it('reports an unsnoozed occurrence as snoozeable with no deadline', () => {
    expect(deriveSnoozeState([], OCCURRENCE)).toEqual({ count: 0, canSnooze: true });
  });

  it('ignores snoozes belonging to a different occurrence', () => {
    const snoozes = [makeSnooze({ id: 'a', occurrenceId: OTHER_OCCURRENCE })];

    expect(deriveSnoozeState(snoozes, OCCURRENCE)).toEqual({ count: 0, canSnooze: true });
  });

  it('runs the deadline from when the caregiver tapped, not from when the dose was due', () => {
    // The dose was due at 08:00 and the tap came at 08:05 — a deadline measured from the due
    // time would already be in the past for anything more than 20 minutes overdue.
    const state = deriveSnoozeState([makeSnooze()], OCCURRENCE);

    expect(state.untilMs).toBe(Date.parse('2026-06-15T08:25:00.000Z'));
  });

  it('uses the household snooze length carried on the record, not a constant', () => {
    const state = deriveSnoozeState([makeSnooze({ minutes: 45 })], OCCURRENCE);

    expect(state.untilMs).toBe(Date.parse('2026-06-15T08:50:00.000Z'));
  });

  it('takes the most recently created snooze, not the most generous one', () => {
    // Two caregivers snoozing concurrently: the later decision wins even though it expires
    // sooner, so the pair converge on one answer rather than on "whoever asked for more".
    const snoozes = [
      makeSnooze({ id: 'a', createdAt: '2026-06-15T08:05:00.000Z', minutes: 60 }),
      makeSnooze({ id: 'b', createdAt: '2026-06-15T08:06:00.000Z', minutes: 20 }),
    ];

    expect(deriveSnoozeState(snoozes, OCCURRENCE).untilMs).toBe(
      Date.parse('2026-06-15T08:26:00.000Z'),
    );
  });

  it('is order-independent — the same records shuffled resolve identically', () => {
    const a = makeSnooze({ id: 'a', createdAt: '2026-06-15T08:05:00.000Z', minutes: 60 });
    const b = makeSnooze({ id: 'b', createdAt: '2026-06-15T08:06:00.000Z', minutes: 20 });

    expect(deriveSnoozeState([a, b], OCCURRENCE)).toEqual(deriveSnoozeState([b, a], OCCURRENCE));
  });

  it('counts snoozes and refuses a fourth', () => {
    const snoozes = Array.from({ length: MAX_SNOOZE_COUNT }, (_, index) =>
      makeSnooze({ id: `s${index}`, count: index + 1, createdAt: `2026-06-15T08:0${index}:00.000Z` }),
    );

    const state = deriveSnoozeState(snoozes, OCCURRENCE);

    expect(state.count).toBe(MAX_SNOOZE_COUNT);
    expect(state.canSnooze).toBe(false);
  });

  it('still allows a snooze one below the bound', () => {
    const snoozes = Array.from({ length: MAX_SNOOZE_COUNT - 1 }, (_, index) =>
      makeSnooze({ id: `s${index}`, count: index + 1, createdAt: `2026-06-15T08:0${index}:00.000Z` }),
    );

    expect(deriveSnoozeState(snoozes, OCCURRENCE).canSnooze).toBe(true);
  });
});

describe('buildDoseSnooze', () => {
  const context = {
    clock: fixedClock('2026-06-15T08:05:00.000Z'),
    ids: sequentialIds('snooze'),
    userId: 'mom',
    deviceId: 'device-1',
  };

  it('mints a 1-based record from the prior count', () => {
    const snooze = buildDoseSnooze(OCCURRENCE, 20, 0, context);

    expect(snooze).toEqual({
      id: 'snooze-1',
      occurrenceId: OCCURRENCE,
      minutes: 20,
      count: 1,
      createdAt: '2026-06-15T08:05:00.000Z',
      createdByUserId: 'mom',
      createdByDeviceId: 'device-1',
      syncStatus: 'pending',
    });
  });

  it('continues the ordinal from an existing count', () => {
    expect(buildDoseSnooze(OCCURRENCE, 20, 2, context).count).toBe(3);
  });

  it('honours an explicit tap instant over the clock', () => {
    // A lock-screen tap is applied later — sometimes much later — and the deferral has to run
    // from when the caregiver actually pressed Snooze (AD2), not from when JS got around to it.
    const snooze = buildDoseSnooze(
      OCCURRENCE,
      20,
      0,
      context,
      Date.parse('2026-06-15T08:01:00.000Z'),
    );

    expect(snooze.createdAt).toBe('2026-06-15T08:01:00.000Z');
  });

  it('round-trips through deriveSnoozeState', () => {
    const first = buildDoseSnooze(OCCURRENCE, DEFAULT_SNOOZE_MINUTES, 0, context);
    const state = deriveSnoozeState([first], OCCURRENCE);

    expect(state.count).toBe(1);
    expect(state.canSnooze).toBe(true);
    expect(state.untilMs).toBe(Date.parse('2026-06-15T08:25:00.000Z'));
  });
});

describe('household setting defaults', () => {
  it('gives three snoozes exactly the escalation window, per the signed-off AD6 timeline', () => {
    expect(DEFAULT_SNOOZE_MINUTES * MAX_SNOOZE_COUNT).toBe(60);
    expect(DEFAULT_ESCALATION_MINUTES).toBe(15);
  });
});
