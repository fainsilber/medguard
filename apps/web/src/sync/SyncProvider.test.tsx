import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixedClock } from '@medguard/shared/testing';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
import { setHouseholdSession } from '../api/session.js';
import { FakeWebSocket } from '../testUtils/FakeWebSocket.js';
import { renderWithRepository } from '../testUtils/renderWithRepository.js';
import { SafetyWarningBanner } from './SafetyWarningBanner.js';
import { SyncProvider } from './SyncProvider.js';
import { SyncStatusBadge } from './SyncStatusBadge.js';

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function stubFetch(
  handler: (url: string) => Response | Promise<Response> = () =>
    jsonResponse({ cursor: 0, records: [], hasMore: false }),
) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => handler(url)));
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
});
