import type { ProbePushPayload } from '@medguard/shared';

/**
 * `renotify`, `vibrate` and `sound` are real, implemented Notification fields that TypeScript's
 * ambient lib.dom.d.ts / lib.webworker.d.ts simply omit — confirmed by reading both files rather
 * than assumed. Extending locally keeps the rest of the service worker honestly typed instead of
 * casting everything to `any`.
 */
export interface ExtendedNotificationOptions extends NotificationOptions {
  renotify?: boolean;
  vibrate?: number[];
  /** Never standardised — included so the probe can observe whether the browser keeps it at all. */
  sound?: string;
}

export type ExtendedNotification = Notification &
  Partial<Pick<ExtendedNotificationOptions, 'renotify' | 'vibrate' | 'sound'>>;

/** Builds the options object to hand to `showNotification`, omitting any key the payload didn't set. */
export function buildNotificationOptions(payload: ProbePushPayload): ExtendedNotificationOptions {
  return {
    body: payload.body,
    data: { burstIndex: payload.burstIndex, burstTotal: payload.burstTotal },
    // exactOptionalPropertyTypes: omit each key entirely when absent rather than assigning
    // `undefined`, so an unset field can't be confused with a field explicitly cleared.
    ...(payload.tag !== undefined ? { tag: payload.tag } : {}),
    ...(payload.renotify !== undefined ? { renotify: payload.renotify } : {}),
    ...(payload.requireInteraction !== undefined ? { requireInteraction: payload.requireInteraction } : {}),
    ...(payload.silent !== undefined ? { silent: payload.silent } : {}),
    ...(payload.vibrate !== undefined ? { vibrate: payload.vibrate } : {}),
    ...(payload.sound !== undefined ? { sound: payload.sound } : {}),
  };
}

/**
 * Compares what we asked for against what the Notification object actually retained. This is
 * the evidence that settles whether a push notification can carry a custom sound at all — an
 * earlier draft of the sprint plan assumed it could, and this proves or disproves it on the
 * device it actually runs on, rather than by reading the spec.
 */
export function retainedOptions(
  payload: ProbePushPayload,
  rendered: ExtendedNotification | undefined,
): string[] {
  if (!rendered) return [];

  const retained: string[] = [];
  if (rendered.tag === payload.tag) retained.push('tag');
  if (rendered.renotify === (payload.renotify ?? false)) retained.push('renotify');
  if (rendered.requireInteraction === (payload.requireInteraction ?? false)) retained.push('requireInteraction');
  if (rendered.silent === (payload.silent ?? null)) retained.push('silent');
  if (JSON.stringify(rendered.vibrate ?? null) === JSON.stringify(payload.vibrate ?? null)) {
    retained.push('vibrate');
  }
  if (payload.sound !== undefined && rendered.sound === payload.sound) retained.push('sound');

  return retained;
}
