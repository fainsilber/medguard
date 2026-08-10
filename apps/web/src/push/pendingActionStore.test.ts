import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { recordPendingAction, webPendingActionSource } from './pendingActionStore.js';

/**
 * The durability contract behind a lock-screen tap.
 *
 * The property that matters is peek/ack, not storage mechanics: reading a captured tap must not
 * remove it, because the page can be closed between the read and the resulting `IntakeLog`
 * committing. `PendingActionStore.kt` makes the same guarantee on Android for the same reason
 * (safety invariant 7 — no log is ever lost).
 */

beforeEach(async () => {
  const existing = await webPendingActionSource.readPendingActions();
  await webPendingActionSource.ackPendingActions(existing.map((action) => action.id));
});

describe('the web pending-action store', () => {
  it('keeps a captured tap readable until it is explicitly acknowledged', async () => {
    await recordPendingAction({
      id: 'action-1',
      occurrenceKey: 'sched-1:2026-08-09T08:00:00.000Z',
      action: 'taken',
      tappedAtMs: 1_770_000_000_000,
    });

    expect(await webPendingActionSource.readPendingActions()).toHaveLength(1);
    // A second read — the normal case when a drain is interrupted — still sees it.
    expect(await webPendingActionSource.readPendingActions()).toHaveLength(1);

    await webPendingActionSource.ackPendingActions(['action-1']);
    expect(await webPendingActionSource.readPendingActions()).toEqual([]);
  });

  it('records the tap instant, not the moment it is read', async () => {
    await recordPendingAction({
      id: 'action-2',
      occurrenceKey: 'sched-1:2026-08-09T08:00:00.000Z',
      action: 'snooze',
      tappedAtMs: 1_770_000_000_000,
    });

    const [stored] = await webPendingActionSource.readPendingActions();
    expect(stored).toMatchObject({ action: 'snooze', tappedAtMs: 1_770_000_000_000 });
  });

  it('acknowledges only what it is asked to', async () => {
    await recordPendingAction({
      id: 'action-3',
      occurrenceKey: 'sched-1:2026-08-09T08:00:00.000Z',
      action: 'taken',
      tappedAtMs: 1,
    });
    await recordPendingAction({
      id: 'action-4',
      occurrenceKey: 'sched-2:2026-08-09T09:00:00.000Z',
      action: 'taken',
      tappedAtMs: 2,
    });

    await webPendingActionSource.ackPendingActions(['action-3']);

    const remaining = await webPendingActionSource.readPendingActions();
    expect(remaining.map((action) => action.id)).toEqual(['action-4']);
  });

  it('treats an empty acknowledgement as a no-op', async () => {
    await expect(webPendingActionSource.ackPendingActions([])).resolves.toBeUndefined();
  });
});
