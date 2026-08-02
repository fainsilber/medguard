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
 * The Shabbat alert (delta D1). A single push gives a ~1-2 second system tone, not the PRD's
 * 45 seconds, so the burst re-alerts the phone across roughly that window using one shared tag
 * with renotify — many notifications' worth of noise, one notification's worth of clutter.
 *
 * Tuning history, from real Sprint 0 capability-probe runs on Android, not guessed:
 *   1. (2026-08-02) 3×/15s arrived instantly and each alert was clearly distinct, but felt too
 *      sparse to reliably wake someone — "I could hear it, but I'd rather have more, like 10 in
 *      the same 45 sec". Changed to 10×/5s.
 *   2. (2026-08-02, same day) after trying 10×/5s: "the frequency was better but I think the
 *      same 10 but in 15 second would be better" — same count, denser. 10×/~1.67s covers a 15s
 *      window instead of 45s.
 *   3. (2026-08-02, Sprint 1 kickoff) requested directly, not yet probe-tested on a device:
 *      10 alerts in 8 seconds — same count again, denser still. 10×/~889ms covers an 8s window.
 *      Confirm this one on-device before treating it as settled the way passes 1 and 2 were.
 */
export const SHABBAT_BURST_COUNT = 10;
// 8s window / (10 - 1) gaps ≈ 889ms, so 10 pushes span ~8s start-to-finish.
export const SHABBAT_BURST_SPACING_MS = 889;

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
