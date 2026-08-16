import * as SecureStore from 'expo-secure-store';
import {
  clearHouseholdSession,
  getHouseholdSession,
  onHouseholdSessionChange,
  setHouseholdSession,
} from './session.js';

/**
 * No direct web mirror — `apps/web/src/api/session.ts` (the same role, `localStorage`-backed) has
 * no dedicated test file of its own either; both are exercised transitively through
 * `HouseholdOnboarding.test.tsx` and `SyncProvider.test.tsx`. This file covers what those don't:
 * the corrupt/malformed-entry handling (`session.ts`'s own doc comment — "treat as absent rather
 * than throwing on startup and bricking the app") and the in-module pub/sub `SyncProvider.tsx`
 * relies on to notice a session change with no shared React context.
 */

const STORAGE_KEY = 'medguard-household-session';

const session = {
  deviceToken: 'tok-1',
  householdId: 'h1',
  userId: 'u1',
  deviceId: 'd1',
};

afterEach(async () => {
  await clearHouseholdSession();
});

describe('household session', () => {
  it('is absent before it is ever set', async () => {
    expect(await getHouseholdSession()).toBeNull();
  });

  it('round-trips a session', async () => {
    await setHouseholdSession(session);
    expect(await getHouseholdSession()).toEqual(session);
  });

  it('can be cleared', async () => {
    await setHouseholdSession(session);
    await clearHouseholdSession();
    expect(await getHouseholdSession()).toBeNull();
  });

  it('treats a corrupt (non-JSON) entry as absent rather than throwing on startup', async () => {
    await SecureStore.setItemAsync(STORAGE_KEY, 'not json at all {{{');
    expect(await getHouseholdSession()).toBeNull();
  });

  it('treats a malformed entry missing the required fields as absent', async () => {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify({ userId: 'u1' }));
    expect(await getHouseholdSession()).toBeNull();
  });

  it('notifies subscribers on set and on clear', async () => {
    const listener = jest.fn();
    const unsubscribe = onHouseholdSessionChange(listener);

    await setHouseholdSession(session);
    expect(listener).toHaveBeenCalledTimes(1);

    await clearHouseholdSession();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await setHouseholdSession(session);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
