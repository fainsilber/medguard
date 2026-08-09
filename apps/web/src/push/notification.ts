import { PUSH_PAYLOAD_VERSION, describePush, pushHasDoseActions } from '@medguard/shared';
import type { PushPayload } from '@medguard/shared';

/**
 * How a push payload becomes a browser notification.
 *
 * Kept out of `sw.ts` so it is testable: that file references `self` at import time and cannot be
 * loaded under a test runner, and this is the part with actual decisions in it — which tag,
 * which actions, whether the notification stays until it is dealt with.
 */

/** What a tapped action means, carried through `notificationclick` on the notification's data. */
export interface NotificationData {
  kind: PushPayload['kind'];
  occurrenceId?: string;
  medicineId: string;
}

export interface PreparedNotification {
  title: string;
  options: NotificationOptions & {
    // Not in TypeScript's DOM lib, but real and load-bearing on Android Chrome.
    actions?: { action: string; title: string }[];
    renotify?: boolean;
    data: NotificationData;
  };
}

/**
 * Rejects a payload this build does not understand.
 *
 * A service worker outlives the app version that installed it — a caregiver's phone can be
 * running one from weeks ago, and there is no way to force it forward before the next dose. An
 * unrecognised version is ignored rather than half-rendered: a missing alert is visibly missing,
 * where a wrong one is trusted.
 */
export function parsePushPayload(raw: unknown): PushPayload | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const candidate = raw as Partial<PushPayload>;
  if (candidate.v !== PUSH_PAYLOAD_VERSION) {
    return null;
  }
  if (
    candidate.kind !== 'dose' &&
    candidate.kind !== 'escalation' &&
    candidate.kind !== 'shabbat' &&
    candidate.kind !== 'low_stock'
  ) {
    return null;
  }
  return candidate as PushPayload;
}

export const TAKEN_ACTION = 'taken';
export const SNOOZE_ACTION = 'snooze';

export function prepareNotification(payload: PushPayload): PreparedNotification {
  const { title, body } = describePush(payload);
  const occurrenceId = 'occurrenceId' in payload ? payload.occurrenceId : undefined;

  return {
    title,
    options: {
      body,
      // The occurrence is the notification's identity, so a late server push *replaces* the one
      // the device already showed for the same dose rather than stacking a second alert beside
      // it. `renotify` is what makes the replacement still alert rather than update silently.
      tag: occurrenceId ?? `medicine:${payload.medicineId}`,
      renotify: true,
      // An escalation means a dose has already gone unanswered once. Letting the OS quietly
      // dismiss it after a few seconds would defeat the entire point of sending it.
      requireInteraction: payload.kind === 'escalation',
      ...(pushHasDoseActions(payload)
        ? {
            actions: [
              { action: TAKEN_ACTION, title: 'Taken' },
              { action: SNOOZE_ACTION, title: 'Snooze' },
            ],
          }
        : // No action buttons on Shabbat (delta D5): tapping one writes a record, which is exactly
          // what must not happen in mode. Reconciliation happens after Havdalah.
          {}),
      data: {
        kind: payload.kind,
        ...(occurrenceId ? { occurrenceId } : {}),
        medicineId: payload.medicineId,
      },
    },
  };
}
