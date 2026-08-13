import { fromIso } from './clock.js';
import type { EpochMs } from './clock.js';
import type { ShabbatConfig, ShabbatWindow } from './types.js';

/**
 * Deciding whether it is Shabbat, from windows somebody else computed.
 *
 * Nothing here computes zmanim. The Worker does that once, with `@hebcal/core`, and publishes
 * `ShabbatWindow` records (PRD §3; `apps/api/src/shabbat/zmanim.ts`); this file is what every
 * surface — the Durable Object's alarm chain, the Android alarm horizon, both clients' UI — reads
 * to turn those windows into a yes or no. One implementation, so the phone and the server can
 * never disagree about whether an escalation should have been sent.
 *
 * Pure, and `nowMs` is always a parameter: a mode boundary is exactly the kind of thing that must
 * be testable at the instant either side of it rather than only when a real Friday arrives.
 *
 * A three-day chag needs no special case anywhere below, because the server publishes it as one
 * long window rather than as adjacent days — merging happens once, where the calendar is read.
 */

/**
 * How long before candle lighting the clients treat Shabbat as imminent.
 *
 * This is an *arming* window, not a halachic one: it exists so a device re-materializes its
 * alarms onto the Shabbat channel before the moment they must already be right, rather than
 * discovering the transition when the first dose is due. Nothing is suppressed during it.
 */
export const PRE_SHABBAT_ARMING_MS = 60 * 60 * 1000;

/**
 * `weekday → pre_shabbat_arming → shabbat_active → motzei_pending → weekday`, the state machine
 * `docs/medguard-sprint-plan.md` § Sprint 6 names.
 *
 * `motzei_pending` is not a time-based state — it lasts until the doses that fell in the window
 * have been reconciled, which is a question about logs, not about clocks. `shabbatPhaseAt` takes
 * that as a caller-supplied fact rather than reading logs itself, so this file stays free of the
 * intake history.
 */
export type ShabbatPhase = 'weekday' | 'pre_shabbat_arming' | 'shabbat_active' | 'motzei_pending';

/** Windows sorted by start, defensively: they arrive from a sync pull in arbitrary order. */
function byStart(windows: readonly ShabbatWindow[]): ShabbatWindow[] {
  return [...windows].sort((a, b) => fromIso(a.startsAt) - fromIso(b.startsAt));
}

/**
 * The window containing `atMs`, if any.
 *
 * Half-open — `[startsAt, endsAt)`. A dose due at exactly candle lighting is in Shabbat; a dose
 * due at exactly Havdalah is not. Both ends have to be decided one way or the other, and this is
 * the direction that fails safe: the cost of treating a boundary dose as being in mode is a
 * missing escalation for one dose, against a written record and an action button on Shabbat.
 */
export function activeWindow(
  windows: readonly ShabbatWindow[],
  atMs: EpochMs,
): ShabbatWindow | undefined {
  return windows.find(
    (window) => fromIso(window.startsAt) <= atMs && atMs < fromIso(window.endsAt),
  );
}

/**
 * Whether the app is in Shabbat mode at `atMs`.
 *
 * `autoShabbatEnabled` gates everything: a household that has not turned automation on gets
 * ordinary weekday behaviour even when windows have been published, which is what makes the
 * setting meaningful rather than decorative. Missing config is the same answer — the server
 * publishes no windows without one, and a device that has never synced one must not guess.
 */
export function shabbatModeAt(
  config: ShabbatConfig | undefined,
  windows: readonly ShabbatWindow[],
  atMs: EpochMs,
): boolean {
  if (!config?.autoShabbatEnabled) {
    return false;
  }
  return activeWindow(windows, atMs) !== undefined;
}

/**
 * The next window starting at or after `atMs`, if one has been published.
 *
 * `undefined` means "nothing published that far ahead", never "no Shabbat is coming" — the
 * distinction matters on the verification screen, where an empty list must read as a publishing
 * gap rather than as a calendar with no Shabbat in it.
 */
export function nextWindow(
  windows: readonly ShabbatWindow[],
  atMs: EpochMs,
): ShabbatWindow | undefined {
  return byStart(windows).find((window) => fromIso(window.startsAt) >= atMs);
}

/**
 * The next `count` windows from `atMs`, including one already in progress.
 *
 * The verification screen's data: eight weeks of these, checked against a luach, is the sprint's
 * exit gate for trusting the computation at all.
 */
export function upcomingWindows(
  windows: readonly ShabbatWindow[],
  atMs: EpochMs,
  count: number,
): ShabbatWindow[] {
  return byStart(windows)
    .filter((window) => fromIso(window.endsAt) > atMs)
    .slice(0, Math.max(0, count));
}

export interface ShabbatPhaseInput {
  config: ShabbatConfig | undefined;
  windows: readonly ShabbatWindow[];
  atMs: EpochMs;
  /**
   * Whether doses from the window that just ended are still awaiting reconciliation. Supplied by
   * the caller (a count of unsuperseded `pending_shabbat` logs) rather than derived here.
   */
  hasUnreconciledDoses?: boolean;
}

export function shabbatPhaseAt(input: ShabbatPhaseInput): ShabbatPhase {
  const { config, windows, atMs } = input;

  if (!config?.autoShabbatEnabled) {
    return 'weekday';
  }

  if (activeWindow(windows, atMs) !== undefined) {
    return 'shabbat_active';
  }

  // Checked before the arming window, because a chag ending hours before the next one begins
  // could otherwise be reported as arming while doses from the one just past are still owed.
  if (input.hasUnreconciledDoses === true) {
    return 'motzei_pending';
  }

  const next = nextWindow(windows, atMs);
  if (next !== undefined && fromIso(next.startsAt) - atMs <= PRE_SHABBAT_ARMING_MS) {
    return 'pre_shabbat_arming';
  }

  return 'weekday';
}
