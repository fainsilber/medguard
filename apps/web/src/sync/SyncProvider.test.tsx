import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock, sequentialIds } from '@medguard/shared/testing';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import { MedGuardRepository } from '@medguard/store';
import { DexieStore } from '@medguard/store/dexie';
import { RepositoryProvider } from '../app/RepositoryContext.js';
import { setHouseholdSession } from '../api/session.js';
import { MedGuardDB } from '../db/schema.js';
import { FakeWebSocket } from '@medguard/store/testing';
import { renderWithRepository } from '../testUtils/renderWithRepository.js';
import { getHouseholdSession } from '../api/session.js';
import { RevokedDeviceBanner } from './RevokedDeviceBanner.js';
import { SafetyWarningBanner } from './SafetyWarningBanner.js';
import { SyncProvider } from './SyncProvider.js';
import { SyncStatusBadge } from './SyncStatusBadge.js';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

/**
 * The default handler answers both pull and push shapes generically, applying every pushed
 * change (echoing each one back as `outcome: 'applied'`, keyed off the request body it actually
 * received — a hardcoded empty `results` would leave the pushed record's local `syncStatus`
 * stuck at "pending" forever, since nothing in the response would match it).
 *
 * Needed because `renderWithRepository` mounts `PatientProvider`, which on a first render with no
 * patients bootstraps a default one (see `PatientProvider.tsx`) — a real local mutation that
 * queues an outbox entry and triggers a genuine push, not just a pull, in every test here.
 */
function defaultFetchHandler(url: string, init?: RequestInit): Response {
  if (url.includes('/sync/push')) {
    const body = init?.body ? (JSON.parse(String(init.body)) as { changes: { table: string; record: { id: string } }[] }) : { changes: [] };
    return jsonResponse({
      cursor: 1,
      results: body.changes.map((change) => ({ table: change.table, id: change.record.id, outcome: 'applied' })),
      blocked: [],
      rejected: [],
    });
  }
  return jsonResponse({ cursor: 0, records: [], hasMore: false });
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> = defaultFetchHandler,
) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => handler(url, init)));
}

beforeEach(() => {
  localStorage.clear();
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('SyncProvider', () => {
  it('shows no sync status at all when this device belongs to no household', async () => {
    await renderWithRepository(
      <SyncProvider>
        <SyncStatusBadge />
      </SyncProvider>,
      { clock: fixedClock('2026-08-03T12:00:00.000Z') },
    );

    expect(screen.queryByText(/Synced|Pending|Offline|Sync error/)).not.toBeInTheDocument();
  });

  it('shows Synced once the live channel is open and nothing is pending', async () => {
    setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });
    stubFetch();

    await renderWithRepository(
      <SyncProvider>
        <SyncStatusBadge />
      </SyncProvider>,
      { clock: fixedClock('2026-08-03T12:00:00.000Z') },
    );

    FakeWebSocket.latest().open();

    await screen.findByText('Synced');
  });

  it('drains the outbox as soon as a new local mutation is queued, not only on a WebSocket event', async () => {
    const dbName = 'SyncProviderTest-outbox-trigger';
    setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });

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

    render(
      <RepositoryProvider userId="Mom" dbName={dbName} clock={fixedClock('2026-08-03T12:00:00.000Z')}>
        <SyncProvider>
          <SyncStatusBadge />
        </SyncProvider>
      </RepositoryProvider>,
    );

    FakeWebSocket.latest().open();
    await screen.findByText('Synced');
    expect(pushCalls).toHaveLength(0);

    // A local mutation on the same database the provider is watching — standing in for what a
    // caregiver adding a medicine or logging a dose through the UI actually does.
    const sideDb = new MedGuardDB(dbName);
    const sideRepository = new MedGuardRepository(new DexieStore(sideDb), {
      clock: fixedClock('2026-08-03T12:00:00.000Z'),
      ids: sequentialIds('seed'),
      userId: 'u1',
      deviceId: 'd1',
    });
    await sideRepository.saveMedicine(
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
    // test ends — otherwise that in-flight work keeps running into the next test's teardown.
    await screen.findByText('Synced');
  });

  it('shows a live safety.warning broadcast with the medicine\'s name, dismissible', async () => {
    const medicineId = '11111111-1111-4111-8111-111111111111';
    setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });
    stubFetch();

    const user = userEvent.setup();
    await renderWithRepository(
      <SyncProvider>
        <SafetyWarningBanner />
      </SyncProvider>,
      {
        clock: fixedClock('2026-08-03T12:00:00.000Z'),
        seed: async (repository) => {
          await repository.saveMedicine({
            id: medicineId,
            patientId: SINGLE_PATIENT_ID,
            name: 'Ondansetron',
            strength: '4mg',
            form: 'pill',
            asNeeded: true,
            archived: false,
            updatedAt: '2026-08-03T10:00:00.000Z',
            updatedByDeviceId: 'device-a',
            syncStatus: 'synced',
          });
        },
      },
    );

    FakeWebSocket.latest().open();
    FakeWebSocket.latest().message({
      type: 'safety.warning',
      medicineId,
      blockedBy: 'cooldown',
      attemptedByUserId: 'user-dad',
      outcome: 'blocked',
    });

    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Ondansetron/));
    expect(screen.getByRole('alert')).toHaveTextContent(/blocked/);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('describes an override differently from an outright block', async () => {
    const medicineId = '22222222-2222-4222-8222-222222222222';
    setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });
    stubFetch();

    await renderWithRepository(
      <SyncProvider>
        <SafetyWarningBanner />
      </SyncProvider>,
      {
        clock: fixedClock('2026-08-03T12:00:00.000Z'),
        seed: async (repository) => {
          await repository.saveMedicine({
            id: medicineId,
            patientId: SINGLE_PATIENT_ID,
            name: 'Morphine',
            strength: '2mg',
            form: 'liquid',
            asNeeded: true,
            archived: false,
            updatedAt: '2026-08-03T10:00:00.000Z',
            updatedByDeviceId: 'device-a',
            syncStatus: 'synced',
          });
        },
      },
    );

    FakeWebSocket.latest().open();
    FakeWebSocket.latest().message({
      type: 'safety.warning',
      medicineId,
      blockedBy: 'daily_cap',
      attemptedByUserId: 'user-dad',
      outcome: 'overridden',
    });

    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/Morphine/));
    expect(screen.getByRole('alert')).toHaveTextContent(/override/i);
  });

  it('shows Removed and the revoked banner once the server rejects this device as unauthorized', async () => {
    setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });
    stubFetch(() => jsonResponse({ error: 'unauthorized' }, 401));

    await renderWithRepository(
      <SyncProvider>
        <SyncStatusBadge />
        <RevokedDeviceBanner />
      </SyncProvider>,
      { clock: fixedClock('2026-08-03T12:00:00.000Z') },
    );

    await screen.findByText('Removed');
    expect(screen.getByRole('alert')).toHaveTextContent(/removed from the household/);
  });

  it('clears local data and the session once the caregiver confirms on the revoked banner', async () => {
    setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });
    stubFetch(() => jsonResponse({ error: 'unauthorized' }, 401));

    const user = userEvent.setup();
    await renderWithRepository(
      <SyncProvider>
        <RevokedDeviceBanner />
      </SyncProvider>,
      { clock: fixedClock('2026-08-03T12:00:00.000Z') },
    );

    await user.click(await screen.findByRole('button', { name: 'Clear local data' }));
    await user.click(screen.getByRole('button', { name: 'Yes, clear it' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(getHouseholdSession()).toBeNull();
  });

  it("retries a sync on the browser's own 'online' event, not only on a WebSocket reconnect", async () => {
    // The gap this closes: a WebSocket can survive a network outage without the browser ever
    // reporting it 'closed' (observed against a real loopback connection under Chromium's
    // offline emulation — apps/web/e2e/live-sync.spec.ts), so `LiveClient`'s 'open' transition,
    // the *other* trigger for a sync retry, may simply never fire. Without a listener for the
    // browser's own connectivity signal, a device stuck like this never recovers on its own.
    setHouseholdSession({ deviceToken: 'tok-1', householdId: 'h1', userId: 'u1', deviceId: 'd1' });

    let failPull = false;
    stubFetch((url, init) => {
      // A fresh device has no cursor yet, so its first pull is a bootstrap, not a delta pull.
      if ((url.includes('/sync/pull') || url.includes('/sync/bootstrap')) && failPull) {
        throw new Error('network unreachable');
      }
      return defaultFetchHandler(url, init);
    });

    await renderWithRepository(
      <SyncProvider>
        <SyncStatusBadge />
      </SyncProvider>,
      { clock: fixedClock('2026-08-03T12:00:00.000Z') },
    );

    // Connects normally first, matching the real scenario: the socket was genuinely open before
    // the outage, and — per `FakeWebSocket` here standing in for the confirmed real behaviour —
    // simply never emits a `close` when the network drops, so it is still 'open' throughout.
    FakeWebSocket.latest().open();
    await screen.findByText('Synced');

    failPull = true;
    // A broadcast arriving mid-outage is what a real sync attempt during one looks like from
    // this component's side — it fails, and the socket is never told it should close.
    FakeWebSocket.latest().message({ type: 'sync', cursor: 1 });
    await screen.findByText('Sync error');

    failPull = false;
    window.dispatchEvent(new Event('online'));

    await screen.findByText('Synced');
  });
});
