import { describe, expect, it } from 'vitest';
import {
  PUSH_CHANNEL_IDS,
  PUSH_PAYLOAD_VERSION,
  describePush,
  pushHasDoseActions,
} from './push.js';
import type {
  DosePushPayload,
  EscalationPushPayload,
  LowStockPushPayload,
  ShabbatPushPayload,
} from './push.js';

const occurrence = {
  v: PUSH_PAYLOAD_VERSION,
  sentAtIso: '2026-08-09T08:00:00.000Z',
  occurrenceId: 'sched-1:2026-08-09T08:00:00.000Z',
  medicineId: 'med-1',
  medicineName: 'Methotrexate',
  scheduleId: 'sched-1',
  dueAtIso: '2026-08-09T08:00:00.000Z',
  dosageQuantity: 2,
} as const;

const dose: DosePushPayload = { ...occurrence, kind: 'dose' };
const escalation: EscalationPushPayload = {
  ...occurrence,
  kind: 'escalation',
  minutesUnacknowledged: 15,
};
const shabbat: ShabbatPushPayload = {
  ...occurrence,
  kind: 'shabbat',
  burstIndex: 1,
  burstTotal: 10,
};
const lowStock: LowStockPushPayload = {
  v: PUSH_PAYLOAD_VERSION,
  sentAtIso: '2026-08-09T08:00:00.000Z',
  kind: 'low_stock',
  medicineId: 'med-1',
  medicineName: 'Methotrexate',
  remaining: 4,
  threshold: 5,
  unitName: 'pills',
};

describe('describePush', () => {
  it('names the medicine in every kind — a notification that says only "dose due" is useless at 3 AM', () => {
    for (const payload of [dose, escalation, shabbat, lowStock]) {
      expect(describePush(payload).title).toContain('Methotrexate');
    }
  });

  it('says how long an escalated dose has been outstanding', () => {
    expect(describePush(escalation).body).toContain('15 minutes ago');
  });

  it('tells a Shabbat recipient that no phone interaction is expected (delta D5)', () => {
    expect(describePush(shabbat).body).toContain('No action needed');
  });

  it('gives both the remaining count and the threshold it crossed', () => {
    const { body } = describePush(lowStock);
    expect(body).toContain('4 pills');
    expect(body).toContain('5');
  });

  it('prefixes the patient name on dose/escalation/shabbat kinds when set, for a multi-patient household', () => {
    expect(describePush({ ...dose, patientName: 'Yoni' }).title).toBe(
      'Yoni · Methotrexate — dose due',
    );
    expect(describePush({ ...escalation, patientName: 'Yoni' }).title).toBe(
      'Yoni · Methotrexate — dose not confirmed',
    );
    expect(describePush({ ...shabbat, patientName: 'Yoni' }).title).toBe(
      'Yoni · Methotrexate — dose due',
    );
  });

  it('omits the patient prefix when unset — a single-patient household reads exactly as before', () => {
    expect(describePush(dose).title).toBe('Methotrexate — dose due');
  });

  it('never prefixes a low-stock alert with a patient — stock is shared, not per-patient', () => {
    expect(describePush(lowStock).title).toBe('Methotrexate — running low');
  });
});

describe('pushHasDoseActions', () => {
  it('offers Taken/Snooze on dose and escalation alerts', () => {
    expect(pushHasDoseActions(dose)).toBe(true);
    expect(pushHasDoseActions(escalation)).toBe(true);
  });

  it('never offers an action on Shabbat — tapping one would write a record (delta D5)', () => {
    expect(pushHasDoseActions(shabbat)).toBe(false);
  });

  it('offers no dose action on a low-stock alert', () => {
    expect(pushHasDoseActions(lowStock)).toBe(false);
  });
});

describe('PUSH_CHANNEL_IDS', () => {
  it("uses versioned ids, since a channel's sound and importance are immutable once created", () => {
    for (const id of Object.values(PUSH_CHANNEL_IDS)) {
      expect(id).toMatch(/_v\d+$/);
    }
  });
});
