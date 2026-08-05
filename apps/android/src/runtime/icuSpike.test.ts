import { describe, expect, it } from 'vitest';
import { fromIso, resolveLocal, toIso, zoneOffsetMs } from '@medguard/shared';

/**
 * AD1 — "Hermes has no guaranteed full ICU." `packages/shared/src/timezone.ts` depends on
 * `Intl.DateTimeFormat` with arbitrary IANA zones, and every wall-clock dose time in the system
 * resolves through it. A React Native engine built without full ICU would silently resolve every
 * zone to UTC — every dose time wrong, plausibly and without an error
 * (docs/android-client-plan.md, AD1).
 *
 * This file is the assertion half of the A0 exit gate: the exact fixtures
 * `packages/shared/src/timezone.test.ts` already uses for the Asia/Jerusalem 2026 DST
 * boundaries. It runs correctly under Vitest/Node (full ICU) proving the import and the
 * arithmetic are wired correctly through this app's Metro/package-exports setup.
 *
 * IT DOES NOT PROVE THE HERMES CASE. Node's V8 always ships full ICU; the failure mode AD1
 * describes is specific to a stripped Hermes build. The actual exit gate — this suite's
 * assertions re-run inside the Expo dev client on a real Android device via the same
 * `@medguard/shared` import path, with `Asia/Jerusalem` selected in device settings — has not
 * been run in this environment (no Android SDK / device here; see apps/android/README.md,
 * "What hasn't been verified").
 */
const JERUSALEM = 'Asia/Jerusalem';

describe('Hermes ICU spike fixtures (AD1)', () => {
  it('flips the Asia/Jerusalem DST offset exactly at the March 2026 transition', () => {
    expect(zoneOffsetMs(JERUSALEM, fromIso('2026-03-26T23:59:59.999Z'))).toBe(2 * 3_600_000);
    expect(zoneOffsetMs(JERUSALEM, fromIso('2026-03-27T00:00:00.000Z'))).toBe(3 * 3_600_000);
  });

  it('flips the Asia/Jerusalem DST offset exactly at the October 2026 transition', () => {
    expect(zoneOffsetMs(JERUSALEM, fromIso('2026-10-24T22:59:59.999Z'))).toBe(3 * 3_600_000);
    expect(zoneOffsetMs(JERUSALEM, fromIso('2026-10-24T23:00:00.000Z'))).toBe(2 * 3_600_000);
  });

  it('resolves an ordinary dose time correctly', () => {
    const result = resolveLocal(JERUSALEM, '2026-01-15', '08:00');
    expect(result.kind).toBe('exact');
    expect(toIso(result.instantMs)).toBe('2026-01-15T06:00:00.000Z');
  });

  it('does not silently resolve a named IANA zone to UTC', () => {
    // The specific danger AD1 names: a missing-ICU Hermes build resolves every zone to UTC. A
    // winter Jerusalem morning dose (+2h) landing on the UTC offset (+0h) is exactly that
    // failure, so asserting the offset is non-zero is the one-line canary for it.
    expect(zoneOffsetMs(JERUSALEM, fromIso('2026-01-15T12:00:00.000Z'))).not.toBe(0);
  });
});
