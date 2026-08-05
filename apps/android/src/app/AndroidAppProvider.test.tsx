import { render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import {
  AndroidAppProvider,
  useClock,
  useCurrentDeviceId,
  useCurrentUserId,
  useIdGenerator,
  useMedGuardDb,
  useRepository,
} from './AndroidAppProvider.js';

function wrapper(userId = 'Mom') {
  return ({ children }: { children: ReactNode }) => (
    <AndroidAppProvider
      userId={userId}
      dbName="AndroidProviderTest"
      clock={fixedClock('2026-06-15T12:00:00.000Z')}
    >
      {children}
    </AndroidAppProvider>
  );
}

describe('AndroidAppProvider', () => {
  it('hands down a repository, database, clock, ids and identity', () => {
    const { result } = renderHook(
      () => ({
        repository: useRepository(),
        db: useMedGuardDb(),
        clock: useClock(),
        ids: useIdGenerator(),
        userId: useCurrentUserId(),
        deviceId: useCurrentDeviceId(),
      }),
      { wrapper: wrapper() },
    );

    expect(result.current.repository).toBeDefined();
    expect(result.current.db.name).toBe('AndroidProviderTest');
    expect(result.current.clock.nowIso()).toBe('2026-06-15T12:00:00.000Z');
    expect(result.current.ids.next()).toEqual(expect.any(String));
    expect(result.current.userId).toBe('Mom');
    expect(result.current.deviceId).toEqual(expect.any(String));
  });

  it('reuses the same device id across renders', () => {
    const { result, rerender } = renderHook(() => useCurrentDeviceId(), { wrapper: wrapper() });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('fails loudly when a hook is used outside the provider', () => {
    // Silently handing back a null repository would surface much later, as a dose that vanished.
    function Orphan() {
      useRepository();
      return null;
    }

    expect(() => render(<Orphan />)).toThrow(/must be used within an AndroidAppProvider/);
  });

  it('renders its children', () => {
    render(
      <AndroidAppProvider userId="Mom" dbName="AndroidProviderChildren">
        ready
      </AndroidAppProvider>,
    );
    expect(screen.getByText('ready')).toBeInTheDocument();
  });
});
