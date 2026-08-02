import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProbePushReceipt } from '@medguard/shared';
import { clearReceipts, getReceipts, saveReceipt } from './receiptStore.js';

function makeReceipt(overrides: Partial<ProbePushReceipt> = {}): ProbePushReceipt {
  return {
    kind: 'probe-push-receipt',
    sentAtIso: '2026-08-02T09:00:00.000Z',
    receivedAtIso: '2026-08-02T09:00:01.000Z',
    burstIndex: 1,
    burstTotal: 1,
    retainedOptions: [],
    ...overrides,
  };
}

// fake-indexeddb keeps its store for the life of the process, and every test in this file works
// against the same medguard-probe database — clear between tests so they stay independent.
beforeEach(async () => {
  await clearReceipts();
});

afterEach(async () => {
  await clearReceipts();
});

describe('receiptStore', () => {
  it('starts empty', async () => {
    await expect(getReceipts()).resolves.toEqual([]);
  });

  it('persists a receipt written from what stands in for the service worker', async () => {
    // The whole reason this store exists rather than a postMessage: the service worker writes
    // here, and the page — reopened later, possibly on a fresh JS context — reads it back.
    await saveReceipt(makeReceipt());
    const receipts = await getReceipts();

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ burstIndex: 1 });
  });

  it('returns receipts ordered by when they were received', async () => {
    await saveReceipt(makeReceipt({ receivedAtIso: '2026-08-02T09:00:03.000Z', burstIndex: 3 }));
    await saveReceipt(makeReceipt({ receivedAtIso: '2026-08-02T09:00:01.000Z', burstIndex: 1 }));
    await saveReceipt(makeReceipt({ receivedAtIso: '2026-08-02T09:00:02.000Z', burstIndex: 2 }));

    const receipts = await getReceipts();
    expect(receipts.map((r) => r.burstIndex)).toEqual([1, 2, 3]);
  });

  it('does not lose a receipt from an earlier burst when a new one is saved', async () => {
    await saveReceipt(makeReceipt({ receivedAtIso: '2026-08-02T09:00:01.000Z' }));
    await saveReceipt(makeReceipt({ receivedAtIso: '2026-08-02T09:15:01.000Z' }));

    await expect(getReceipts()).resolves.toHaveLength(2);
  });

  it('clears everything on request', async () => {
    await saveReceipt(makeReceipt());
    await clearReceipts();

    await expect(getReceipts()).resolves.toEqual([]);
  });
});
