/**
 * Time and identity are injected, never read from ambient globals.
 *
 * Every cooldown, dose cap, escalation window, DST boundary and Shabbat transition in this
 * app is a function of "what time is it". Making that an explicit dependency is what lets the
 * whole safety layer be tested deterministically, without sleeping and without a real device.
 *
 * An ESLint rule (see eslint.config.js) fails the build if domain code reaches for
 * `new Date()`, `Date.now()`, `crypto.randomUUID()` or `Math.random()` directly.
 */

/** An instant in time, as epoch milliseconds. */
export type EpochMs = number;

/** An instant in time, as an ISO-8601 string in UTC with milliseconds (`2026-08-02T09:15:00.000Z`). */
export type IsoInstant = string;

export interface Clock {
  /** Current instant as epoch milliseconds. Use for arithmetic. */
  nowMs(): EpochMs;
  /** Current instant as an ISO-8601 UTC string. Use for storage and the wire. */
  nowIso(): IsoInstant;
}

export interface IdGenerator {
  /** A fresh, globally unique identifier. */
  next(): string;
}

/**
 * How much a clock is trusted.
 *
 * Safety invariant 3 — fail closed, never open. A device whose clock is wrong (or unverified)
 * must not be allowed to satisfy a cooldown check, so cooldown evaluation consults this and
 * degrades to RED rather than GREEN. Wired up in Sprint 2 against the Sprint 3 server-time
 * endpoint; the shape is fixed here so nothing downstream has to change later.
 */
export type ClockTrust =
  /** Offset against server time is known and within tolerance. */
  | { readonly kind: 'trusted'; readonly offsetMs: number }
  /** Never yet checked against the server — treat as untrustworthy. */
  | { readonly kind: 'unverified' }
  /** Checked, and off by more than the tolerance. */
  | { readonly kind: 'skewed'; readonly offsetMs: number };

/** Skew beyond this is treated as untrustworthy. Generous enough to survive normal NTP drift. */
export const CLOCK_SKEW_TOLERANCE_MS = 2 * 60 * 1000;

export function isClockTrusted(trust: ClockTrust): boolean {
  return trust.kind === 'trusted';
}

/** Convert epoch milliseconds to the canonical ISO-8601 UTC storage format. */
export function toIso(ms: EpochMs): IsoInstant {
  return new Date(ms).toISOString();
}

/**
 * A `Clock` frozen at one instant.
 *
 * For evaluating a time-dependent rule *as of* some moment other than now — which is exactly what
 * a retroactively recorded dose needs (Sprint A5 phase 2): a dose given during Shabbat and entered
 * after Havdalah must have its cooldown and cap assessed against when it was actually given, not
 * against the moment somebody got round to typing it in. `HouseholdDO.checkDoseSafety` already
 * does this on the server side; this is the same thing, named, so both sides mean it identically.
 *
 * Not a test double — `fixedClock` in `testing.ts` is that. This is production code, used where
 * "now" is genuinely not the instant in question.
 */
export function clockAt(instantMs: EpochMs): Clock {
  const iso = toIso(instantMs);
  return { nowMs: () => instantMs, nowIso: () => iso };
}

/**
 * Parse an ISO-8601 instant. Throws rather than returning `Invalid Date`, because a silently
 * invalid timestamp inside a cooldown calculation is exactly the kind of failure that must be
 * loud rather than quiet.
 */
export function fromIso(iso: IsoInstant): EpochMs {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`Not a valid ISO-8601 instant: ${JSON.stringify(iso)}`);
  }
  return ms;
}
