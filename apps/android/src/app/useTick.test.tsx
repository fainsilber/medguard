import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTick } from './useTick.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useTick', () => {
  it('re-renders on the interval, so anything derived from "now" stays current', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      useTick(1_000);
    });

    expect(renders).toBe(1);

    // Advanced one interval at a time: React batches state updates, so three timers fired inside
    // a single `act` would collapse into one render and prove nothing about the cadence.
    for (const expected of [2, 3, 4]) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(renders).toBe(expected);
    }
  });

  it('stops ticking once unmounted', () => {
    let renders = 0;
    const { unmount } = renderHook(() => {
      renders += 1;
      useTick(1_000);
    });

    unmount();
    const after = renders;

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(renders).toBe(after);
  });
});
