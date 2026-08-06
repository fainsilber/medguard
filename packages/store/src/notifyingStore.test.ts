import { describe, expect, it, vi } from 'vitest';
import type { Store, StoreTransaction } from './types.js';
import { NotifyingStore } from './notifyingStore.js';

/** A minimal fake `Store` that just runs `fn` against a stub transaction, recording calls. */
function makeFakeStore(): { store: Store; calls: string[][] } {
  const calls: string[][] = [];
  const tx = {} as StoreTransaction;
  const store: Store = {
    async transaction(tables, fn) {
      calls.push([...tables]);
      return fn(tx);
    },
  };
  return { store, calls };
}

describe('NotifyingStore', () => {
  it('delegates transaction() to the inner store and returns its result', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);

    const result = await notifying.transaction(['medicines'], async () => 'ok');

    expect(result).toBe('ok');
  });

  it('notifies a subscriber watching a table touched by the transaction', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    notifying.subscribe(['medicines'], listener);

    await notifying.transaction(['medicines', 'syncOutbox'], async () => undefined);

    expect(listener).toHaveBeenCalledWith(['medicines', 'syncOutbox']);
  });

  it('does not notify a subscriber watching an untouched table', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    notifying.subscribe(['schedules'], listener);

    await notifying.transaction(['medicines'], async () => undefined);

    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies every matching subscriber for one commit', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);
    const medicinesListener = vi.fn();
    const outboxListener = vi.fn();
    const scheduleListener = vi.fn();
    notifying.subscribe(['medicines'], medicinesListener);
    notifying.subscribe(['syncOutbox'], outboxListener);
    notifying.subscribe(['schedules'], scheduleListener);

    await notifying.transaction(['medicines', 'syncOutbox'], async () => undefined);

    expect(medicinesListener).toHaveBeenCalledTimes(1);
    expect(outboxListener).toHaveBeenCalledTimes(1);
    expect(scheduleListener).not.toHaveBeenCalled();
  });

  it('still notifies for a read-only transaction — deliberately coarse', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    notifying.subscribe(['medicines'], listener);

    await notifying.transaction(['medicines'], async (tx) => tx);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops further notifications', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    const unsubscribe = notifying.subscribe(['medicines'], listener);

    await notifying.transaction(['medicines'], async () => undefined);
    unsubscribe();
    await notifying.transaction(['medicines'], async () => undefined);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a listener watching multiple tables fires once even if several of its tables are touched', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    notifying.subscribe(['medicines', 'schedules'], listener);

    await notifying.transaction(['medicines', 'schedules', 'syncOutbox'], async () => undefined);

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('propagates a thrown error from the inner transaction without notifying', async () => {
    const store: Store = {
      transaction: () => Promise.reject(new Error('boom')),
    };
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    notifying.subscribe(['medicines'], listener);

    await expect(notifying.transaction(['medicines'], async () => undefined)).rejects.toThrow('boom');
    expect(listener).not.toHaveBeenCalled();
  });
});
