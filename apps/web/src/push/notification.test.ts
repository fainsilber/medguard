import { describe, expect, it } from 'vitest';
import { PUSH_PAYLOAD_VERSION } from '@medguard/shared';
import type { DosePushPayload, LowStockPushPayload } from '@medguard/shared';
import { SNOOZE_ACTION, TAKEN_ACTION, parsePushPayload, prepareNotification } from './notification.js';

const dose: DosePushPayload = {
  v: PUSH_PAYLOAD_VERSION,
  kind: 'dose',
  sentAtIso: '2026-08-09T08:00:00.000Z',
  occurrenceId: 'sched-1:2026-08-09T08:00:00.000Z',
  medicineId: 'med-1',
  medicineName: 'Methotrexate',
  scheduleId: 'sched-1',
  dueAtIso: '2026-08-09T08:00:00.000Z',
  dosageQuantity: 2,
};

describe('parsePushPayload', () => {
  it('accepts a payload of the version this build understands', () => {
    expect(parsePushPayload(dose)).toEqual(dose);
  });

  it('ignores a payload from a newer server rather than half-rendering it', () => {
    expect(parsePushPayload({ ...dose, v: PUSH_PAYLOAD_VERSION + 1 })).toBeNull();
  });

  it('ignores a kind it has no rules for', () => {
    expect(parsePushPayload({ ...dose, kind: 'something_new' })).toBeNull();
  });

  it('ignores anything that is not an object', () => {
    expect(parsePushPayload('dose due')).toBeNull();
    expect(parsePushPayload(null)).toBeNull();
  });
});

describe('prepareNotification', () => {
  it('tags a dose alert with its occurrence, so a late server push replaces the local one', () => {
    const { options } = prepareNotification(dose);
    expect(options.tag).toBe(dose.occurrenceId);
    expect(options.renotify).toBe(true);
  });

  it('offers Taken and Snooze on a dose alert', () => {
    const { options } = prepareNotification(dose);
    expect(options.actions?.map((action) => action.action)).toEqual([TAKEN_ACTION, SNOOZE_ACTION]);
  });

  it('keeps an escalation on screen until it is dealt with', () => {
    const { options } = prepareNotification({
      ...dose,
      kind: 'escalation',
      minutesUnacknowledged: 15,
    });
    expect(options.requireInteraction).toBe(true);
  });

  it('does not hold an ordinary dose alert on screen', () => {
    expect(prepareNotification(dose).options.requireInteraction).toBe(false);
  });

  it('shows no action buttons on Shabbat — tapping one would write a record (delta D5)', () => {
    const { options } = prepareNotification({
      ...dose,
      kind: 'shabbat',
      burstIndex: 1,
      burstTotal: 10,
    });
    expect(options.actions).toBeUndefined();
  });

  it('falls back to the medicine as the tag when there is no occurrence', () => {
    const lowStock: LowStockPushPayload = {
      v: PUSH_PAYLOAD_VERSION,
      kind: 'low_stock',
      sentAtIso: '2026-08-09T08:00:00.000Z',
      medicineId: 'med-1',
      medicineName: 'Methotrexate',
      remaining: 4,
      threshold: 5,
      unitName: 'pills',
    };
    const { options } = prepareNotification(lowStock);
    expect(options.tag).toBe('medicine:med-1');
    expect(options.actions).toBeUndefined();
    expect(options.data.occurrenceId).toBeUndefined();
  });

  it('carries the occurrence through to the click handler', () => {
    expect(prepareNotification(dose).options.data).toEqual({
      kind: 'dose',
      occurrenceId: dose.occurrenceId,
      medicineId: 'med-1',
    });
  });
});
