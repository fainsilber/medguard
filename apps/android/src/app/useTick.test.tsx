import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { useTick } from './useTick.js';

/**
 * Regression test for the real-device PRN report this fix addresses: a caregiver locks the phone
 * for a few hours, then reopens the "As needed" screen and sees a cooldown reporting far more
 * time remaining than has actually elapsed. `Date.now()` itself is always correct when read —
 * `packages/shared/src/safety.ts`'s `assessDose` is pure and reads a fresh clock on every call —
 * the bug is that nothing was forcing a fresh render to happen after a real device sleep, so a
 * stale `PrnCard` kept showing whatever it last computed. `setInterval` alone can't be trusted to
 * self-correct promptly: RN timers stop making progress while the app is backgrounded (the same
 * failure mode `apps/android/src/clock/localClockGuard.ts` documents for `performance.now()`), so
 * this asserts the fix explicitly — a re-render fires the moment `AppState` reports 'active',
 * without waiting for the next scheduled interval tick.
 */

function currentListener(): ((state: string) => void) | undefined {
  const addEventListener = AppState.addEventListener as jest.Mock;
  const call = addEventListener.mock.calls.at(-1);
  return call?.[1];
}

describe('useTick', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(AppState, 'addEventListener');
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('re-renders on the configured interval', () => {
    const renderSpy = jest.fn();
    renderHook(() => {
      useTick(1000);
      renderSpy();
    });

    expect(renderSpy).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(renderSpy).toHaveBeenCalledTimes(2);
  });

  it('re-renders immediately when the app returns to the foreground, without waiting for the interval', () => {
    const renderSpy = jest.fn();
    renderHook(() => {
      useTick(60_000);
      renderSpy();
    });
    expect(renderSpy).toHaveBeenCalledTimes(1);

    // The app sat backgrounded well short of the interval elapsing — a locked phone, not a
    // scheduled tick — so only the AppState resume should be able to explain the next render.
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(renderSpy).toHaveBeenCalledTimes(1);

    act(() => {
      currentListener()?.('active');
    });
    expect(renderSpy).toHaveBeenCalledTimes(2);
  });

  it('does not re-render for a transition away from active', () => {
    const renderSpy = jest.fn();
    renderHook(() => {
      useTick(60_000);
      renderSpy();
    });
    expect(renderSpy).toHaveBeenCalledTimes(1);

    act(() => {
      currentListener()?.('background');
    });
    expect(renderSpy).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes from AppState on unmount', () => {
    const removeSpy = jest.fn();
    (AppState.addEventListener as jest.Mock).mockReturnValue({ remove: removeSpy });

    const { unmount } = renderHook(() => useTick(1000));
    unmount();

    expect(removeSpy).toHaveBeenCalledTimes(1);
  });
});
