import { useEffect } from 'react';
import { fireEvent, waitFor } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import type { Medicine } from '@medguard/shared';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import { MedGuardRepository } from '@medguard/store';
import { SqliteStore } from '@medguard/store/sqlite';
import * as SQLite from 'expo-sqlite';
import { useRepository } from '../app/RepositoryContext.js';
import { createSqliteSchema, ExpoSqliteDriver } from '../store/expoSqliteDriver.js';
import { getHouseholdSession, setHouseholdSession } from '../identity/session.js';
import { FakeWebSocket } from '../testUtils/FakeWebSocket.js';
import { renderWithRepository } from '../testUtils/renderWithRepository.js';
import { seedPatient } from '../testUtils/seedAlarmData.js';
import { RevokedDeviceBanner } from './RevokedDeviceBanner.js';
import { SafetyWarningBanner } from './SafetyWarningBanner.js';
import { SyncProvider } from './SyncProvider.js';
import { SyncStatusBadge } from './SyncStatusBadge.js';

/**
 * RN port of `apps/web/src/sync/SyncProvider.test.tsx` — same `SyncEngine`/`LiveClient` from
 * `@medguard/store`, same state machine, so this proves the Android wiring around it: the async
 * `expo-secure-store` session read, `api/syncApi.ts` and `api/householdApi.ts` (unreached by any
 * other Jest test — this is the only thing in the Android suite that exercises them), and the
 * three banner/badge components' rendering off `useSyncStatus()`.
 *
 * Assertions query by visible text rather than `getByRole('alert')`, unlike the web mirror —
 * matching every other Jest test in this app (see e.g. `AlarmHealthBanner.test.tsx`): the banner
 * `View`s here set `accessibilityRole="alert"` without `accessible={true}`, which
 * `@testing-library/react-native`'s role matcher doesn't surface, unlike the `Button`s underneath
 * (RN's `Pressable`-backed buttons set `accessible={true}` themselves) — button role queries below
 * work for exactly that reason.
 *
 * Not ported: web's "retries on the browser's own 'online' event" test. There is no `window` in
 * React Native and `SyncProvider.tsx` has no such listener — that failure mode (a WebSocket that
 * survives a network outage without ever reporting `'closed'`) was found against a real loopback
 * connection under Chromium; nothing here claims it does or doesn't also apply to a phone's radio.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

/**
 * Answers `/sync/push` by echoing back an `applied` result for every change actually in the
 * request body, rather than a fixed shape — `PatientProvider`'s first-run bootstrap now queues a
 * real `patients` CREATE the moment the tree mounts (see `PatientProvider.tsx`), so every test
 * using `renderWithRepository` pushes at least that one record even when the test itself never
 * touches a medicine. A handler that only knows about one hardcoded table/id would leave that
 * write permanently unacknowledged, which is exactly what caused "Sync error"/stuck "Pending"
 * here before this existed — the same fix `apps/web/src/sync/SyncProvider.test.tsx` needed for the
 * same reason.
 */
function defaultFetchHandler(url: string, init?: RequestInit): Response {
  if (url.includes('/sync/push') && typeof init?.body === 'string') {
    const body = JSON.parse(init.body) as {
      changes: Array<{ table: string; record: { id: string } }>;
    };
    return jsonResponse({
      cursor: 1,
      results: body.changes.map((change) => ({
        table: change.table,
        id: change.record.id,
        outcome: 'applied',
      })),
      blocked: [],
      rejected: [],
    });
  }
  return jsonResponse({ cursor: 0, records: [], hasMore: false });
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> = defaultFetchHandler,
): void {
  global.fetch = jest.fn(async (url: string, init?: RequestInit) =>
    handler(url, init),
  ) as unknown as typeof fetch;
}

/** Hands the rendered tree's own repository instance back to the test — needed wherever a test
 * has to write through the *same* `NotifyingStore` `SyncProvider` is subscribed to, not a second
 * store instance pointed at the same database file. Unlike Dexie's `useLiveQuery` (which observes
 * IndexedDB itself, so any instance's write is visible), `NotifyingStore`'s reactivity is JS-level
 * pub/sub scoped to one instance (`packages/store/src/notifyingStore.ts`) — a write through a
 * second, unrelated `SqliteStore` opened on the same file changes the data on disk but never fires
 * the subscription `useLiveQuery` is waiting on. */
function CaptureRepository({ onReady }: { onReady: (repository: MedGuardRepository) => void }) {
  const repository = useRepository();
  useEffect(() => {
    onReady(repository);
  }, [repository, onReady]);
  return null;
}

async function seedMedicineDirect(
  dbName: string,
  medicine: {
    id: string;
    name: string;
    strength: string;
    form: Medicine['form'];
  },
): Promise<void> {
  const db = await SQLite.openDatabaseAsync(dbName);
  await createSqliteSchema(db);
  const repository = new MedGuardRepository(new SqliteStore(new ExpoSqliteDriver(db)), {
    clock: fixedClock('2026-08-03T12:00:00.000Z'),
    ids: sequentialIds('seed'),
    userId: 'device-a',
    deviceId: 'device-a',
  });
  await repository.saveMedicine(
    {
      id: medicine.id,
      patientId: SINGLE_PATIENT_ID,
      name: medicine.name,
      strength: medicine.strength,
      form: medicine.form,
      asNeeded: true,
      archived: false,
      updatedAt: '2026-08-03T10:00:00.000Z',
      updatedByDeviceId: 'device-a',
      syncStatus: 'synced',
    },
    'CREATE',
  );
}

let originalWebSocket: typeof WebSocket | undefined;

beforeEach(() => {
  FakeWebSocket.reset();
  originalWebSocket = global.WebSocket;
  global.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  global.WebSocket = originalWebSocket as typeof WebSocket;
  jest.restoreAllMocks();
});

describe('SyncProvider', () => {
  it('shows no sync status at all when this device belongs to no household', async () => {
    const { queryByText, findByText } = renderWithRepository(
      <SyncProvider>
        {/* `SyncStatusBadge` renders null in the disconnected state, so this sibling is what
            proves the repository actually finished loading before the absence below is checked —
            otherwise this would trivially pass before `RepositoryProvider`'s own async setup
            (opening the SQLite double, reading the device id) has completed at all. */}
        <Text>ready</Text>
        <SyncStatusBadge />
      </SyncProvider>,
      { dbName: 'sync-provider-no-household.db' },
    );

    await findByText('ready');
    expect(queryByText(/Synced|Pending|Offline|Sync failed|Retrying|Removed/)).toBeFalsy();
  });

  it('shows Synced once the live channel is open and nothing is pending', async () => {
    const dbName = 'sync-provider-synced.db';
    await setHouseholdSession({
      deviceToken: 'tok-1',
      householdId: 'h1',
      userId: 'u1',
      deviceId: 'd1',
    });
    stubFetch();

    const { findByText } = renderWithRepository(
      <SyncProvider>
        <SyncStatusBadge />
      </SyncProvider>,
      { dbName },
    );

    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    FakeWebSocket.latest().open();

    await findByText('Synced');
  });

  it('drains the outbox as soon as a new local mutation is queued, not only on a WebSocket event', async () => {
    const dbName = 'sync-provider-outbox-trigger.db';
    await setHouseholdSession({
      deviceToken: 'tok-1',
      householdId: 'h1',
      userId: 'u1',
      deviceId: 'd1',
    });

    const pushCalls: unknown[] = [];
    stubFetch((url, init) => {
      if (url.includes('/sync/push')) {
        pushCalls.push(url);
      }
      return defaultFetchHandler(url, init);
    });

    let repository: MedGuardRepository | undefined;
    const { findByText } = renderWithRepository(
      <SyncProvider>
        <CaptureRepository
          onReady={(r) => {
            repository = r;
          }}
        />
        <SyncStatusBadge />
      </SyncProvider>,
      { dbName },
    );

    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    FakeWebSocket.latest().open();
    await findByText('Synced');
    // `PatientProvider`'s first-run bootstrap has already pushed its own `patients` CREATE by this
    // point — that's a real push, just not the one this test is about — so the count is reset here
    // rather than asserted as zero, and the mutation below is what's actually under test.
    pushCalls.length = 0;

    // A local mutation through the repository the running provider itself watches — standing in
    // for what a caregiver adding a medicine or logging a dose through the UI does.
    await repository!.saveMedicine(
      {
        id: 'm1',
        patientId: SINGLE_PATIENT_ID,
        name: 'Ondansetron',
        strength: '4mg',
        form: 'pill',
        asNeeded: true,
        archived: false,
        updatedAt: '2026-08-03T10:00:00.000Z',
        updatedByDeviceId: 'd1',
        syncStatus: 'pending',
      },
      'CREATE',
    );

    await waitFor(() => expect(pushCalls.length).toBeGreaterThan(0));
    // Let the rest of runOnce() (the pull half, and the pending-count refresh) settle before the
    // test ends, so it doesn't keep running into the next test's teardown.
    await findByText('Synced');
  });

  it('shows a live safety.warning broadcast with the medicine’s name, dismissible', async () => {
    const dbName = 'sync-provider-safety-warning.db';
    const medicineId = '11111111-1111-4111-8111-111111111111';
    await setHouseholdSession({
      deviceToken: 'tok-1',
      householdId: 'h1',
      userId: 'u1',
      deviceId: 'd1',
    });
    stubFetch();
    await seedMedicineDirect(dbName, {
      id: medicineId,
      name: 'Ondansetron',
      strength: '4mg',
      form: 'pill',
    });

    const { findByText, getByText } = renderWithRepository(
      <SyncProvider>
        <SafetyWarningBanner />
      </SyncProvider>,
      { dbName },
    );

    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    FakeWebSocket.latest().open();
    FakeWebSocket.latest().message({
      type: 'safety.warning',
      medicineId,
      blockedBy: 'cooldown',
      attemptedByUserId: 'user-dad',
      outcome: 'blocked',
    });

    await findByText(/Ondansetron/);
    expect(getByText(/blocked/)).toBeTruthy();

    fireEvent.press(getByText('Dismiss'));
    await waitFor(() => expect(() => getByText(/Ondansetron/)).toThrow());
  });

  it('describes an override differently from an outright block', async () => {
    const dbName = 'sync-provider-safety-override.db';
    const medicineId = '22222222-2222-4222-8222-222222222222';
    await setHouseholdSession({
      deviceToken: 'tok-1',
      householdId: 'h1',
      userId: 'u1',
      deviceId: 'd1',
    });
    stubFetch();
    await seedMedicineDirect(dbName, {
      id: medicineId,
      name: 'Morphine',
      strength: '2mg',
      form: 'liquid',
    });

    const { findByText, getByText } = renderWithRepository(
      <SyncProvider>
        <SafetyWarningBanner />
      </SyncProvider>,
      { dbName },
    );

    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    FakeWebSocket.latest().open();
    FakeWebSocket.latest().message({
      type: 'safety.warning',
      medicineId,
      blockedBy: 'daily_cap',
      attemptedByUserId: 'user-dad',
      outcome: 'overridden',
    });

    await findByText(/Morphine/);
    expect(getByText(/override/i)).toBeTruthy();
  });

  it("names the patient once the household has more than one, using the broadcast's own patientId", async () => {
    const dbName = 'sync-provider-safety-multi-patient.db';
    const medicineId = '33333333-3333-4333-8333-333333333333';
    const yoniId = '44444444-4444-4444-8444-444444444444';
    const dadId = '55555555-5555-4555-8555-555555555555';
    await setHouseholdSession({
      deviceToken: 'tok-1',
      householdId: 'h1',
      userId: 'u1',
      deviceId: 'd1',
    });
    stubFetch();
    await seedMedicineDirect(dbName, {
      id: medicineId,
      name: 'Paracetamol',
      strength: '500mg',
      form: 'pill',
    });
    await seedPatient(dbName, {
      id: yoniId,
      displayName: 'Yoni',
      archived: false,
      sortOrder: 0,
      updatedAt: '2026-08-03T10:00:00.000Z',
      updatedByDeviceId: 'device-a',
      syncStatus: 'synced',
    });
    await seedPatient(dbName, {
      id: dadId,
      displayName: 'Dad',
      archived: false,
      sortOrder: 1,
      updatedAt: '2026-08-03T10:00:00.000Z',
      updatedByDeviceId: 'device-a',
      syncStatus: 'synced',
    });

    const { findByText } = renderWithRepository(
      <SyncProvider>
        <SafetyWarningBanner />
      </SyncProvider>,
      { dbName },
    );

    await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
    FakeWebSocket.latest().open();
    FakeWebSocket.latest().message({
      type: 'safety.warning',
      medicineId,
      patientId: yoniId,
      blockedBy: 'cooldown',
      attemptedByUserId: 'user-dad',
      outcome: 'blocked',
    });

    await findByText(/Yoni · Paracetamol/);
  });

  it('shows Removed and the revoked banner once the server rejects this device as unauthorized', async () => {
    const dbName = 'sync-provider-revoked.db';
    await setHouseholdSession({
      deviceToken: 'tok-1',
      householdId: 'h1',
      userId: 'u1',
      deviceId: 'd1',
    });
    stubFetch(() => jsonResponse({ error: 'unauthorized' }, 401));

    const { findByText, getByText } = renderWithRepository(
      <SyncProvider>
        <SyncStatusBadge />
        <RevokedDeviceBanner />
      </SyncProvider>,
      { dbName },
    );

    await findByText('Removed');
    expect(getByText(/removed from the household/)).toBeTruthy();
  });

  it('clears local data and the session once the caregiver confirms on the revoked banner', async () => {
    const dbName = 'sync-provider-revoked-clear.db';
    await setHouseholdSession({
      deviceToken: 'tok-1',
      householdId: 'h1',
      userId: 'u1',
      deviceId: 'd1',
    });
    stubFetch(() => jsonResponse({ error: 'unauthorized' }, 401));

    const { findByRole, getByRole, queryByText } = renderWithRepository(
      <SyncProvider>
        <RevokedDeviceBanner />
      </SyncProvider>,
      { dbName },
    );

    fireEvent.press(await findByRole('button', { name: 'Clear local data' }));
    fireEvent.press(getByRole('button', { name: 'Yes, clear it' }));

    // Longer than this file's other waitFor calls: the banner unmounting goes through two
    // sequential async hops — clearRevokedDevice's own await chain, then the
    // onHouseholdSessionChange listener's `getHouseholdSession()` re-read and the resulting
    // re-render — not just one, so RTL's default 1000ms timeout is tighter than this legitimately
    // needs under a loaded CI runner.
    await waitFor(() => expect(queryByText(/removed from the household/)).toBeFalsy(), {
      timeout: 5_000,
    });
    expect(await getHouseholdSession()).toBeNull();
  });

  describe('retry and manual sync', () => {
    const session = { deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' };

    afterEach(() => {
      jest.useRealTimers();
    });

    /** A fetch whose sync calls fail (a dropped connection, not a 401) until `ok()` is called. */
    function flakyFetch() {
      const state = { failing: true, calls: 0 };
      stubFetch((url, init) => {
        if (url.includes('/sync/')) {
          state.calls += 1;
          if (state.failing) {
            throw new Error('network down');
          }
        }
        return defaultFetchHandler(url, init);
      });
      return state;
    }

    it('retries a failed sync three times on its own, then shows the failure and stops', async () => {
      await setHouseholdSession(session);
      jest.useFakeTimers();
      const net = flakyFetch();

      const { findByText } = renderWithRepository(
        <SyncProvider>
          <SyncStatusBadge />
        </SyncProvider>,
        { dbName: 'sync-provider-retry.db' },
      );

      await findByText('Retrying (1/3)…');
      await jest.advanceTimersByTimeAsync(5_000);
      await findByText('Retrying (2/3)…');
      await jest.advanceTimersByTimeAsync(15_000);
      await findByText('Retrying (3/3)…');
      await jest.advanceTimersByTimeAsync(45_000);
      await findByText('Sync failed · tap to retry');

      // Nothing more happens on its own.
      const callsWhenGivenUp = net.calls;
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(net.calls).toBe(callsWhenGivenUp);
    });

    it('a retry that succeeds clears the retrying state', async () => {
      await setHouseholdSession(session);
      jest.useFakeTimers();
      const net = flakyFetch();

      const { findByText } = renderWithRepository(
        <SyncProvider>
          <SyncStatusBadge />
        </SyncProvider>,
        { dbName: 'sync-provider-retry-ok.db' },
      );

      await findByText('Retrying (1/3)…');
      net.failing = false;
      await jest.advanceTimersByTimeAsync(5_000);
      FakeWebSocket.latest().open();
      await findByText('Synced');
    });

    it('tapping the badge after a failure syncs again, and shows a repeat failure straight away', async () => {
      await setHouseholdSession(session);
      jest.useFakeTimers();
      const net = flakyFetch();

      const { findByText, findByRole, queryByText } = renderWithRepository(
        <SyncProvider>
          <SyncStatusBadge />
        </SyncProvider>,
        { dbName: 'sync-provider-manual.db' },
      );

      await findByText('Retrying (1/3)…');
      await jest.advanceTimersByTimeAsync(5_000 + 15_000 + 45_000);
      await findByText('Sync failed · tap to retry');
      // The reason is visible, not just a generic label.
      expect(queryByText(/Could not reach the server/)).toBeTruthy();

      // Still failing: the tap's own failure is shown at once, not hidden behind more retries.
      const before = net.calls;
      fireEvent.press(await findByRole('button', { name: 'Sync now' }));
      await waitFor(() => expect(net.calls).toBeGreaterThan(before));
      await findByText('Sync failed · tap to retry');
      expect(queryByText(/Retrying/)).toBeNull();

      // Connection back: one more tap and it is synced.
      net.failing = false;
      FakeWebSocket.latest().open();
      fireEvent.press(await findByRole('button', { name: 'Sync now' }));
      await findByText('Synced');
    });

    it('syncs when the app returns to the foreground', async () => {
      await setHouseholdSession(session);
      let onChange: ((state: string) => void) | undefined;
      jest.spyOn(AppState, 'addEventListener').mockImplementation(((
        _type: string,
        listener: (state: string) => void,
      ) => {
        onChange = listener;
        return { remove: () => {} };
      }) as unknown as typeof AppState.addEventListener);
      let pulls = 0;
      stubFetch((url, init) => {
        if (url.includes('/sync/pull') || url.includes('/sync/bootstrap')) {
          pulls += 1;
        }
        return defaultFetchHandler(url, init);
      });

      const { findByText } = renderWithRepository(
        <SyncProvider>
          <SyncStatusBadge />
        </SyncProvider>,
        { dbName: 'sync-provider-foreground.db' },
      );
      await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
      FakeWebSocket.latest().open();
      await findByText('Synced');
      await waitFor(() => expect(onChange).toBeDefined());

      const before = pulls;
      onChange!('background');
      onChange!('active');
      await waitFor(() => expect(pulls).toBeGreaterThan(before));
    });

    it('never retries a revoked device, and the badge is not tappable', async () => {
      await setHouseholdSession(session);
      jest.useFakeTimers();
      let calls = 0;
      stubFetch(() => {
        calls += 1;
        return jsonResponse({ error: 'unauthorized' }, 401);
      });

      const { findByText, getByRole } = renderWithRepository(
        <SyncProvider>
          <SyncStatusBadge />
        </SyncProvider>,
        { dbName: 'sync-provider-revoked-no-retry.db' },
      );

      await findByText('Removed');
      expect(getByRole('button', { name: 'Sync now' }).props.accessibilityState).toMatchObject({
        disabled: true,
      });
      const settled = calls;
      await jest.advanceTimersByTimeAsync(10 * 60_000);
      expect(calls).toBe(settled);
    });
  });
});
