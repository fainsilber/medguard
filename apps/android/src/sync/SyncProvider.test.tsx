import { useEffect } from 'react';
import { fireEvent, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
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

function stubFetch(
  handler: (url: string) => Response | Promise<Response> = () =>
    jsonResponse({ cursor: 0, records: [], hasMore: false }),
): void {
  global.fetch = jest.fn(async (url: string) => handler(url)) as unknown as typeof fetch;
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
    expect(queryByText(/Synced|Pending|Offline|Sync error|Removed/)).toBeFalsy();
  });

  it('shows Synced once the live channel is open and nothing is pending', async () => {
    const dbName = 'sync-provider-synced.db';
    await setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });
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
    await setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });

    const pushCalls: unknown[] = [];
    stubFetch((url) => {
      if (url.includes('/sync/push')) {
        pushCalls.push(url);
        return jsonResponse({
          cursor: 1,
          results: [{ table: 'medicines', id: 'm1', outcome: 'applied' }],
          blocked: [],
          rejected: [],
        });
      }
      return jsonResponse({ cursor: 0, records: [], hasMore: false });
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
    expect(pushCalls).toHaveLength(0);

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
    await setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });
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
    await setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });
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

  it('shows Removed and the revoked banner once the server rejects this device as unauthorized', async () => {
    const dbName = 'sync-provider-revoked.db';
    await setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });
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
    await setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });
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
    await waitFor(() => expect(queryByText(/removed from the household/)).toBeFalsy(), { timeout: 5_000 });
    expect(await getHouseholdSession()).toBeNull();
  });
});
