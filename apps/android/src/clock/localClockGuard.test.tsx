import { CLOCK_SKEW_TOLERANCE_MS } from '@medguard/shared';

/**
 * The Android clock guard is not a straight port of `apps/web/src/clock/localClockGuard.test.ts`
 * — see `localClockGuard.ts`'s doc comment for why `performance.now()` had to be replaced with a
 * native `elapsedRealtimeMs()` bridge call, and why that turns this into a background refresh
 * loop with cached, synchronously-read state instead of a pure function. This file proves the
 * refresh loop itself: the fail-open default before any sample lands, that a normal lock/unlock
 * cycle (elapsedRealtime advancing through sleep) reads as trusted, that a wall-clock-only jump
 * (elapsedRealtime *not* advancing to match) reads as skewed, and — the property this rewrite
 * exists for — that re-anchoring on every sample, even a skewed one, never launders a real tamper
 * attempt (`localClockGuard.ts`'s doc comment walks through why).
 *
 * `.test.tsx` despite no JSX: this file reaches `react-native`'s `AppState` and the native alarm
 * module through `localClockGuard.ts`'s own imports, so per `jest.config.js`'s convention it runs
 * under Jest, not Vitest.
 *
 * Each test gets a fully fresh module graph via `jest.resetModules()` — `localClockGuard.ts`
 * keeps `anchor`/`trust` as module-scoped state by design (`getLocalClockTrust()` must be
 * synchronous), so a test can't otherwise start from a clean slate. `react-native` and the native
 * alarm module are re-imported alongside it in the same call so the `AppState` reference this file
 * spies on is the exact instance `localClockGuard.ts` itself ends up importing — a stale reference
 * captured before a reset would silently miss every call.
 */

// `require`, not a dynamic `import()` — this Jest project runs under CommonJS, and a dynamic
// `import()` throws ("invoked without --experimental-vm-modules") without a much bigger config
// change. `require` gets the same fresh-module behavior after `jest.resetModules()`.
function freshModule() {
  jest.resetModules();
  const rn = require('react-native') as typeof import('react-native');
  const native = require('../../modules/medguard-alarms/src') as typeof import(
    '../../modules/medguard-alarms/src'
  );
  const guard = require('./localClockGuard.js') as typeof import('./localClockGuard.js');
  return { AppState: rn.AppState, elapsedRealtimeMs: native.elapsedRealtimeMs, ...guard };
}

/** Flushes the microtask queue past `refresh()`'s one `await elapsedRealtimeMs()`. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('localClockGuard (Android)', () => {
  // Every test below calls `startLocalClockGuard()` at least once, which — unmocked — starts a
  // real `setInterval(refresh, 30_000)`. None of these tests wait 30 real seconds for it to fire
  // (they drive refreshes on demand via the AppState handler instead), so left running it's just
  // a leaked timer handle that keeps the Jest process alive after the run completes. Mocking it
  // globally means every test starts from the same clean slate without repeating this per test.
  let setIntervalSpy: jest.SpiedFunction<typeof setInterval>;
  let clearIntervalSpy: jest.SpiedFunction<typeof clearInterval>;

  beforeEach(() => {
    setIntervalSpy = jest
      .spyOn(global, 'setInterval')
      .mockReturnValue(12345 as unknown as ReturnType<typeof setInterval>);
    clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('defaults to trusted before any sample has landed — the same fail-open instant web has', async () => {
    const { getLocalClockTrust } = freshModule();
    expect(getLocalClockTrust()).toEqual({ kind: 'trusted', offsetMs: 0 });
  });

  it('stays trusted after the very first sample, with no prior anchor to compare it against', async () => {
    const { getLocalClockTrust, startLocalClockGuard, elapsedRealtimeMs } = freshModule();
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000);

    startLocalClockGuard();
    await flush();

    expect(getLocalClockTrust()).toEqual({ kind: 'trusted', offsetMs: 0 });
  });

  it('trusts a normal lock/unlock cycle — wall time and elapsedRealtime advance together through sleep', async () => {
    const { getLocalClockTrust, startLocalClockGuard, elapsedRealtimeMs, AppState } =
      freshModule();
    const addEventListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValue({ remove: jest.fn() });
    const dateNow = jest.spyOn(Date, 'now');
    dateNow.mockReturnValue(1_000_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000);
    startLocalClockGuard();
    await flush();

    // Ten minutes pass while the phone is locked, then it's unlocked — the app's own foreground
    // resume is what drives the next sample, same as on a real device. elapsedRealtime keeps
    // counting through sleep, unlike the performance.now() this replaced, so it also advances the
    // full ten minutes: the whole point of the fix.
    const onChange = addEventListener.mock.calls[0]![1] as (state: string) => void;
    dateNow.mockReturnValue(1_000_000 + 600_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000 + 600_000);
    onChange('active');
    await flush();

    expect(getLocalClockTrust()).toEqual({ kind: 'trusted', offsetMs: 0 });
  });

  it('flags a wall clock that advanced without elapsedRealtime advancing to match — a real tamper', async () => {
    const { getLocalClockTrust, startLocalClockGuard, elapsedRealtimeMs, AppState } =
      freshModule();
    const addEventListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValue({ remove: jest.fn() });
    const dateNow = jest.spyOn(Date, 'now');
    dateNow.mockReturnValue(1_000_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000);
    startLocalClockGuard();
    await flush();

    const onChange = addEventListener.mock.calls[0]![1] as (state: string) => void;

    // Wall jumps 10 minutes forward; elapsedRealtime — immune to a caregiver changing the system
    // clock, since it isn't the system clock — only advances 10 seconds.
    dateNow.mockReturnValue(1_000_000 + 10 * 60_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000 + 10_000);
    onChange('active');
    await flush();

    const trust = getLocalClockTrust();
    expect(trust.kind).toBe('skewed');
    expect(trust.kind === 'skewed' && trust.offsetMs).toBeGreaterThan(0);
  });

  it('flags a wall clock wound backward', async () => {
    const { getLocalClockTrust, startLocalClockGuard, elapsedRealtimeMs, AppState } =
      freshModule();
    const addEventListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValue({ remove: jest.fn() });
    const dateNow = jest.spyOn(Date, 'now');
    dateNow.mockReturnValue(1_000_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000);
    startLocalClockGuard();
    await flush();

    const onChange = addEventListener.mock.calls[0]![1] as (state: string) => void;
    dateNow.mockReturnValue(1_000_000 - 10 * 60_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000 + 1_000);
    onChange('active');
    await flush();

    const trust = getLocalClockTrust();
    expect(trust.kind).toBe('skewed');
    expect(trust.kind === 'skewed' && trust.offsetMs).toBeLessThan(0);
  });

  it('tolerates drift within the shared skew tolerance', async () => {
    const { getLocalClockTrust, startLocalClockGuard, elapsedRealtimeMs, AppState } =
      freshModule();
    const addEventListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValue({ remove: jest.fn() });
    const dateNow = jest.spyOn(Date, 'now');
    dateNow.mockReturnValue(1_000_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000);
    startLocalClockGuard();
    await flush();

    const onChange = addEventListener.mock.calls[0]![1] as (state: string) => void;
    dateNow.mockReturnValue(1_000_000 + 1_000 + (CLOCK_SKEW_TOLERANCE_MS - 1));
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000 + 1_000);
    onChange('active');
    await flush();

    expect(getLocalClockTrust().kind).toBe('trusted');
  });

  it('flags drift exactly one millisecond past the tolerance', async () => {
    const { getLocalClockTrust, startLocalClockGuard, elapsedRealtimeMs, AppState } =
      freshModule();
    const addEventListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValue({ remove: jest.fn() });
    const dateNow = jest.spyOn(Date, 'now');
    dateNow.mockReturnValue(1_000_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000);
    startLocalClockGuard();
    await flush();

    const onChange = addEventListener.mock.calls[0]![1] as (state: string) => void;
    dateNow.mockReturnValue(1_000_000 + 1_000 + (CLOCK_SKEW_TOLERANCE_MS + 1));
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000 + 1_000);
    onChange('active');
    await flush();

    expect(getLocalClockTrust().kind).toBe('skewed');
  });

  it('re-anchors even on a skewed read, so a later normal sample reports trusted again', async () => {
    // The property `localClockGuard.ts`'s doc comment calls out as the reason re-anchoring is
    // safe here (unlike web's deliberately-sticky design): rolling the anchor forward after a
    // skewed read only ever discards *explained* drift on the next check, never launders a real
    // tamper — the very next sample, taken fresh, would catch it again if it were still happening.
    const { getLocalClockTrust, startLocalClockGuard, elapsedRealtimeMs, AppState } =
      freshModule();
    const addEventListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValue({ remove: jest.fn() });
    const dateNow = jest.spyOn(Date, 'now');
    dateNow.mockReturnValue(1_000_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000);
    startLocalClockGuard();
    await flush();
    const onChange = addEventListener.mock.calls[0]![1] as (state: string) => void;

    // Second sample: a real tamper. Confirms the guard is skewed before the property under test.
    dateNow.mockReturnValue(1_000_000 + 10 * 60_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000 + 10_000);
    onChange('active');
    await flush();
    expect(getLocalClockTrust().kind).toBe('skewed');

    // Third sample: wall and elapsedRealtime advance together again from the (skewed) anchor.
    dateNow.mockReturnValue(1_000_000 + 10 * 60_000 + 1_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000 + 10_000 + 1_000);
    onChange('active');
    await flush();

    expect(getLocalClockTrust()).toEqual({ kind: 'trusted', offsetMs: 0 });
  });

  it('keeps the last known trust value when the native bridge call fails, rather than guessing', async () => {
    const { getLocalClockTrust, startLocalClockGuard, elapsedRealtimeMs, AppState } =
      freshModule();
    const addEventListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValue({ remove: jest.fn() });
    const dateNow = jest.spyOn(Date, 'now');
    dateNow.mockReturnValue(1_000_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValueOnce(5_000);
    startLocalClockGuard();
    await flush();
    const before = getLocalClockTrust();

    const onChange = addEventListener.mock.calls[0]![1] as (state: string) => void;
    (elapsedRealtimeMs as jest.Mock).mockRejectedValueOnce(new Error('bridge unavailable'));
    onChange('active');
    await flush();

    expect(getLocalClockTrust()).toEqual(before);
  });

  it('only refreshes on a transition to active, not on every AppState change', async () => {
    const { elapsedRealtimeMs, startLocalClockGuard, AppState } = freshModule();
    const addEventListener = jest
      .spyOn(AppState, 'addEventListener')
      .mockReturnValue({ remove: jest.fn() });
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    (elapsedRealtimeMs as jest.Mock).mockResolvedValue(5_000);
    startLocalClockGuard();
    await flush();
    (elapsedRealtimeMs as jest.Mock).mockClear();

    const onChange = addEventListener.mock.calls[0]![1] as (state: string) => void;
    onChange('background');
    await flush();

    expect(elapsedRealtimeMs).not.toHaveBeenCalled();
  });

  it('starts a periodic refresh and tears it down on cleanup', async () => {
    const { startLocalClockGuard, AppState } = freshModule();
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockReturnValue({ remove });
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000);

    const stop = startLocalClockGuard();
    // 30s — the module's own REFRESH_INTERVAL_MS. A change here is a real behavior change (how
    // stale the cached trust value can get while foregrounded), not incidental to update quietly.
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);

    stop();

    expect(remove).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalledWith(12345);
  });
});
