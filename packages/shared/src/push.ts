import type { IsoInstant } from './clock.js';

/**
 * The push payload contract between the Worker and the service worker.
 *
 * Defined here so both sides compile against the same shape — a mismatch would only show up
 * as a notification silently failing to render on a locked phone, which is the hardest
 * possible place to debug.
 */

/**
 * Notification options we want evidence about, rather than assumptions.
 *
 * `sound` is deliberately included: sprint plan v1.0 claimed a push could carry a custom
 * notification sound via the Android channel, and I believe it cannot — the Notification API's
 * `sound` property was never implemented and the channel belongs to the browser, not to us.
 * The probe sends it and reports whether the browser retained it, settling the question with
 * evidence instead of argument.
 */
export interface ProbeNotificationOptions {
  tag?: string;
  renotify?: boolean;
  requireInteraction?: boolean;
  silent?: boolean;
  vibrate?: number[];
  sound?: string;
}

export interface ProbePushPayload extends ProbeNotificationOptions {
  kind: 'probe';
  title: string;
  body: string;
  /** Server send time, so the client can report end-to-end delivery latency. */
  sentAtIso: IsoInstant;
  /** 1-based position within a burst, for the Shabbat 3-push test. */
  burstIndex: number;
  burstTotal: number;
}

/** Message the service worker posts back to any open page when a push arrives. */
export interface ProbePushReceipt {
  kind: 'probe-push-receipt';
  sentAtIso: IsoInstant;
  receivedAtIso: IsoInstant;
  burstIndex: number;
  burstTotal: number;
  /** Which of the requested options the browser actually kept on the Notification object. */
  retainedOptions: string[];
}

/**
 * The Shabbat alert.
 *
 * A browser Notification can't play a custom sound or a long chime — a single push gets a
 * ~1-2 second system tone, nowhere near the PRD's 45-second Shabbat chime. So instead of one
 * push, we send a rapid burst of several, sharing one notification tag with `renotify` — the
 * phone re-alerts on each one rather than stacking a pile of separate notifications. It reads
 * as one sustained alert made of several buzzes, approximating a longer chime out of pieces a
 * push service can actually deliver.
 *
 * Tuned three times from real Sprint 0 device tests, not guessed:
 *   1. (2026-08-02, Android) 3 pushes / 15s apart arrived instantly and each buzz was clearly
 *      distinct, but felt too sparse to reliably wake someone — "I could hear it, but I'd rather
 *      have more, like 10 in the same 45 sec". Changed to 10 pushes / 5s apart.
 *   2. (2026-08-02, Android, same day) after trying that: "the frequency was better but I think
 *      the same 10 but in 15 second would be better" — same count, denser: 10 pushes spanning a
 *      15s window (~1.67s apart) instead of 45s.
 *   3. (2026-08-03, Android) tried tightening further to 10 pushes spanning 8s (~889ms apart,
 *      committed only on the Sprint 1 branch, never merged to main) — too tight: "the alerts are
 *      so close to one another that the OS prevents some and I didn't hear 10 chimes." The
 *      Android OS was coalescing or dropping some of the notifications rather than showing every
 *      one. Backed off to 10 pushes spanning 10s (~1.11s apart) — this is the current value.
 *
 * Still open: the same test on iOS, and a real Shabbat dry run. (iOS push delivery itself was
 * separately confirmed working once the PWA is installed to the home screen — see
 * docs/platform-capabilities.md — but this exact burst spacing hasn't been tried there.)
 */
export const SHABBAT_BURST_COUNT = 10;
// 10s window / (10 - 1) gaps ≈ 1111ms, so 10 pushes span ~10s start-to-finish. Pass 3 above
// (889ms) was tried and found too tight — the OS started dropping notifications rather than
// showing all ten.
export const SHABBAT_BURST_SPACING_MS = 1_111;

/**
 * What the server actually did with one queued push — read by the probe UI (and, later, any
 * caregiver-facing delivery-status view) to tell "never sent" apart from "sent, but the phone
 * never showed it". That distinction is otherwise pure guesswork on a locked device.
 */
export interface ProbeSendRecord {
  burstIndex: number;
  burstTotal: number;
  dueAtIso: IsoInstant;
  sentAtIso: IsoInstant;
  /** Alarm accuracy: how late the Durable Object actually woke up relative to the scheduled time. */
  latenessMs: number;
  ok: boolean;
  status: number;
  error?: string;
}

export interface ProbePushLog {
  pending: number;
  sent: ProbeSendRecord[];
}
