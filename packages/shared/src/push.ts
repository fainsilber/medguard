import type { IsoInstant } from './clock.js';

/**
 * The push payload contract between the Worker and whatever displays the notification — the web
 * app's service worker, or the Android app's `FirebaseMessagingService`.
 *
 * Defined here so every side compiles against the same shape. A mismatch would only show up as a
 * notification silently failing to render on a locked phone, which is the hardest possible place
 * to debug — and for this app, a dose alert that never appears is the failure that matters most.
 *
 * Sprint 0's `ProbePushPayload` lived here until Sprint A4 replaced it. The probe answered
 * "does a push reach a locked phone at all"; it has, on both platforms
 * (`docs/platform-capabilities.md`), so what remains is the real thing.
 */

/**
 * Bumped when a field's meaning changes in a way an older client would render wrongly.
 *
 * A push outlives the app version that receives it: a caregiver's phone can hold a service worker
 * from weeks ago, and there is no way to force it forward before the next dose alert. A client
 * that doesn't recognise the version ignores the message rather than rendering a half-understood
 * notification — a missing alert is at least visibly missing, where a wrong one is trusted.
 */
export const PUSH_PAYLOAD_VERSION = 1;

interface PushPayloadBase {
  v: typeof PUSH_PAYLOAD_VERSION;
  /** Server send time. End-to-end delivery latency, and the age of an alert that arrived late. */
  sentAtIso: IsoInstant;
}

interface OccurrencePushBase extends PushPayloadBase {
  /**
   * An `occurrenceKey` — `${scheduleId}:${dueAt}`, from `schedule.ts`.
   *
   * Doubles as the notification tag on both clients, which is what makes a late server push
   * *replace* the device's own local notification for the same dose instead of stacking a second
   * one next to it (see "Local versus server alarms" in `docs/android-client-plan.md`).
   */
  occurrenceId: string;
  medicineId: string;
  /** Denormalized so the notification can render without a database read on a woken device. */
  medicineName: string;
  scheduleId: string;
  dueAtIso: IsoInstant;
  /** `Schedule.dosageQuantity`; rendered with the medicine's strength, never used in arithmetic. */
  dosageQuantity: number;
}

/** The ordinary scheduled-dose alert, sent at the occurrence's due time. */
export interface DosePushPayload extends OccurrencePushBase {
  kind: 'dose';
}

/**
 * The dose went unacknowledged past the household's `escalationAfterMinutes`, so every other
 * caregiver is told. Escalation is server-only by construction: a phone cannot know whether
 * somebody else's phone acknowledged.
 */
export interface EscalationPushPayload extends OccurrencePushBase {
  kind: 'escalation';
  /** How long the dose has been outstanding, so the notification can say it rather than imply it. */
  minutesUnacknowledged: number;
}

/**
 * Informational only — no action buttons, ever (delta D5). Tapping one on Shabbat would write
 * data; reconciliation happens after Havdalah instead.
 *
 * `burstIndex`/`burstTotal` are meaningful for `webpush` devices only: a browser notification
 * yields a ~1-2 second tone, so the web client approximates the PRD's 45-second chime out of a
 * burst of pushes. A native device plays the real chime from a local alarm and receives exactly
 * one of these (delta AD3).
 */
export interface ShabbatPushPayload extends OccurrencePushBase {
  kind: 'shabbat';
  burstIndex: number;
  burstTotal: number;
}

/** PRD §2.4 — stock crossed the refill threshold, on every caregiver's device. */
export interface LowStockPushPayload extends PushPayloadBase {
  kind: 'low_stock';
  medicineId: string;
  medicineName: string;
  /** Current derived quantity, from the adjustment ledger. */
  remaining: number;
  threshold: number;
  /** Display only, e.g. "pills", "ml". */
  unitName: string;
}

export type PushPayload =
  | DosePushPayload
  | EscalationPushPayload
  | ShabbatPushPayload
  | LowStockPushPayload;

export type PushKind = PushPayload['kind'];

/**
 * The Android notification channel each kind belongs to.
 *
 * Ids are versioned because a channel's sound and importance are immutable once created — see
 * `MedGuardChannels.kt`. Named here rather than in Kotlin so the server can put the channel id in
 * the message and the two cannot drift; Kotlin still owns creating them.
 */
export const PUSH_CHANNEL_IDS: Record<PushKind, string> = {
  dose: 'dose_standard_v1',
  escalation: 'dose_escalation_v1',
  shabbat: 'shabbat_v1',
  low_stock: 'low_stock_v1',
};

/**
 * Whether a notification of this kind carries "Taken" / "Snooze" buttons.
 *
 * Shabbat is the whole reason this is a function and not a constant: tapping an action writes a
 * record, which is exactly what must not happen in mode (delta D5).
 */
export function pushHasDoseActions(payload: PushPayload): boolean {
  return payload.kind === 'dose' || payload.kind === 'escalation';
}

/**
 * The notification's text, composed once and shared.
 *
 * Both clients render the same words for the same event: the web service worker calls this
 * directly, and the FCM message carries its output as `title`/`body` in the data map because
 * Kotlin cannot call it. That indirection is deliberate — the alternative is a second copy of
 * this wording in a language with no test over it, which is how "Dose due" and "Dose overdue"
 * end up meaning different things on the two phones in one household.
 */
export function describePush(payload: PushPayload): { title: string; body: string } {
  switch (payload.kind) {
    case 'dose':
      return {
        title: `${payload.medicineName} — dose due`,
        body: `${payload.dosageQuantity} due now`,
      };
    case 'escalation':
      return {
        title: `${payload.medicineName} — dose not confirmed`,
        body: `Due ${payload.minutesUnacknowledged} minutes ago and still unconfirmed. Can you check?`,
      };
    case 'shabbat':
      return {
        title: `${payload.medicineName} — dose due`,
        body: `${payload.dosageQuantity} due now. No action needed on the phone.`,
      };
    case 'low_stock':
      return {
        title: `${payload.medicineName} — running low`,
        body: `${payload.remaining} ${payload.unitName} left (refill at ${payload.threshold}).`,
      };
  }
}

/**
 * The Shabbat alert, on the web.
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
 * Retired for `fcm` devices (delta AD3): a native client plays the real 45 seconds from a local
 * alarm, so a burst there would be ten redundant notifications rather than one long chime.
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
