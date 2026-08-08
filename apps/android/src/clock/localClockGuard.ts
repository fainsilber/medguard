import { AppState } from 'react-native';
import { CLOCK_SKEW_TOLERANCE_MS } from '@medguard/shared';
import type { ClockTrust } from '@medguard/shared';
import { elapsedRealtimeMs } from '../../modules/medguard-alarms/src';

/**
 * Android port of `apps/web/src/clock/localClockGuard.ts` — but no longer a straight one, since a
 * real-device PRN report (2026-08-08) found web's design doesn't survive Android's process model.
 *
 * **What web's version (and this file's first draft) got wrong on Android:** the monotonic
 * reference was `performance.now()`, reasoned to be safe because it's "not settable from JS." True,
 * but beside the point — the actual property this guard needs is "never *appears* to jump except
 * when the wall clock is tampered with," and `performance.now()` fails that on Android specifically.
 * It's backed by `std::chrono::steady_clock` (`ReactCommon/react/timing/primitives.h`), which maps
 * to `CLOCK_MONOTONIC` on Android/Linux — a clock that **stops advancing during real device sleep**
 * (screen off, Doze), unlike `Date.now()`, which keeps advancing in real time regardless. A caregiver
 * who simply locks the phone for a few minutes — this app's entire reason for existing — makes the
 * wall clock look like it raced ahead of the "monotonic" one, indistinguishable by this guard's own
 * math from tampering. And since the guard deliberately never re-anchors mid-session (see below for
 * why that's still right), once tripped it stayed tripped for the rest of the session: every guarded
 * PRN medicine became unusable without an override, on a phone that had ever been locked.
 *
 * **The fix:** use `android.os.SystemClock.elapsedRealtime()` instead (via the native
 * `elapsedRealtimeMs` export added alongside this fix, `modules/medguard-alarms`) — milliseconds
 * since boot *including* sleep. It has the one property that actually matters here: a caregiver
 * cannot move it by changing the system clock, because it isn't the system clock — it's a kernel
 * timer `Date.now()` doesn't touch. Unlike `performance.now()`, it also doesn't stop during sleep,
 * so a normal lock/unlock cycle no longer looks like tampering.
 *
 * **Why re-anchoring the reference is safe now, when it deliberately wasn't before:** the original
 * design never re-anchored specifically because doing so against a *spoofable* clock would let a
 * caregiver "wait out" a flagged tamper attempt — background the app, wind the clock, foreground
 * again, and a re-anchored `performance.now()`-based guard would treat the already-tampered wall
 * time as the new trusted baseline. `elapsedRealtime()` has no such hole: it cannot be moved by
 * anything JS-observable, so rolling the anchor forward after each measurement never launders a
 * real tamper attempt — it only ever discards *explained* drift (sleep), never *unexplained* drift
 * (tampering), because unexplained drift is exactly what a fresh measurement against this clock
 * would catch again on the very next refresh.
 *
 * **The synchronous/async mismatch this creates, and how it's resolved:** `getLocalClockTrust()`
 * is called synchronously during render (`PrnCard`'s `assessDose` call), but the accurate clock
 * source is now behind an async native bridge call. Resolution: a background refresh loop
 * (`startLocalClockGuard()`, started once by `PrnScreen`) samples `elapsedRealtimeMs()` on an
 * interval and on every foreground resume, caching the resulting trust value; `getLocalClockTrust()`
 * just reads that cache. The brief window before the first sample ever lands defaults to `trusted`
 * — the same fail-open behavior the original synchronous version had at the instant it first loaded.
 *
 * See `apps/web/src/clock/localClockGuard.ts` for the browser version's rationale — its threat
 * model (a caregiver changing the wall clock in an open, still-running tab) doesn't have this
 * failure mode, since a browser tab doesn't survive real OS-level suspend the way a backgrounded
 * Android app does, so it was left alone.
 */

interface Anchor {
  wallMs: number;
  elapsedRealtimeMs: number;
}

let anchor: Anchor | null = null;
let trust: ClockTrust = { kind: 'trusted', offsetMs: 0 };

async function refresh(): Promise<void> {
  let sampleMs: number;
  try {
    sampleMs = await elapsedRealtimeMs();
  } catch {
    // Bridge call failed (or is unavailable, e.g. under an incomplete test double) — keep the
    // last known trust value rather than guessing from a failed read.
    return;
  }
  const wallMs = Date.now();

  if (anchor) {
    const wallElapsedMs = wallMs - anchor.wallMs;
    const trueElapsedMs = sampleMs - anchor.elapsedRealtimeMs;
    const driftMs = wallElapsedMs - trueElapsedMs;
    trust =
      Math.abs(driftMs) > CLOCK_SKEW_TOLERANCE_MS
        ? { kind: 'skewed', offsetMs: driftMs }
        : { kind: 'trusted', offsetMs: driftMs };
  }

  // Safe to roll forward even on a 'skewed' read — see the doc comment above on why this never
  // launders a real tamper attempt the way re-anchoring a spoofable clock would.
  anchor = { wallMs, elapsedRealtimeMs: sampleMs };
}

/** The current cached local clock trust. Synchronous — see the doc comment above for why. */
export function getLocalClockTrust(): ClockTrust {
  return trust;
}

const REFRESH_INTERVAL_MS = 30_000;

/**
 * Starts the background refresh loop: an immediate sample, then one on every foreground resume
 * (the case that actually matters — a phone that was just locked) plus a periodic safety-net
 * interval while foregrounded. Call once, near the top of the app (`PrnScreen`, the sole production
 * consumer of `getLocalClockTrust()`); returns a cleanup function for the calling effect.
 */
export function startLocalClockGuard(): () => void {
  void refresh();

  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void refresh();
    }
  });
  const intervalId = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);

  return () => {
    subscription.remove();
    clearInterval(intervalId);
  };
}
