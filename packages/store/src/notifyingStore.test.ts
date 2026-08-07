import { describe, expect, it, vi } from 'vitest';
import type { Store, StoreTransaction } from './types.js';
import { NotifyingStore } from './notifyingStore.js';

/** A minimal fake `Store` with real (no-op) transaction methods, so write calls can be exercised. */
function makeFakeStore(): { store: Store; calls: string[][] } {
  const calls: string[][] = [];
  const tx: StoreTransaction = {
    get: async () => undefined,
    getAll: async () => [],
    queryIndex: async () => [],
    count: async () => 0,
    put: async () => {},
    bulkPut: async () => {},
    append: async () => 1,
    update: async () => {},
    delete: async () => {},
    clear: async () => {},
  };
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

  it('notifies a subscriber watching a table touched by a transaction that wrote', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    notifying.subscribe(['medicines'], listener);

    await notifying.transaction(['medicines', 'syncOutbox'], async (tx) => {
      await tx.put('medicines', { id: 'm1' });
    });

    expect(listener).toHaveBeenCalledWith(['medicines', 'syncOutbox']);
  });

  it('does not notify a subscriber watching an untouched table', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    notifying.subscribe(['schedules'], listener);

    await notifying.transaction(['medicines'], async (tx) => {
      await tx.put('medicines', { id: 'm1' });
    });

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

    await notifying.transaction(['medicines', 'syncOutbox'], async (tx) => {
      await tx.put('medicines', { id: 'm1' });
    });

    expect(medicinesListener).toHaveBeenCalledTimes(1);
    expect(outboxListener).toHaveBeenCalledTimes(1);
    expect(scheduleListener).not.toHaveBeenCalled();
  });

  it('does NOT notify for a read-only transaction', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    notifying.subscribe(['medicines'], listener);

    await notifying.transaction(['medicines'], async (tx) => tx.getAll('medicines'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not notify when fn touches tx.get/getAll/queryIndex/count only', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    notifying.subscribe(['medicines'], listener);

    await notifying.transaction(['medicines'], async (tx) => {
      await tx.get('medicines', 'm1');
      await tx.queryIndex('medicines', { kind: 'all', orderBy: 'id' });
      await tx.count('medicines');
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it.each(['put', 'bulkPut', 'append', 'update', 'delete', 'clear'] as const)(
    'notifies when the transaction calls tx.%s',
    async (method) => {
      const { store } = makeFakeStore();
      const notifying = new NotifyingStore(store);
      const listener = vi.fn();
      notifying.subscribe(['medicines'], listener);

      await notifying.transaction(['medicines'], async (tx) => {
        switch (method) {
          case 'put':
            await tx.put('medicines', { id: 'm1' });
            break;
          case 'bulkPut':
            await tx.bulkPut('medicines', [{ id: 'm1' }]);
            break;
          case 'append':
            await tx.append('medicines', { id: 'm1' });
            break;
          case 'update':
            await tx.update('medicines', 'm1', {});
            break;
          case 'delete':
            await tx.delete('medicines', 'm1');
            break;
          case 'clear':
            await tx.clear('medicines');
            break;
        }
      });

      expect(listener).toHaveBeenCalledTimes(1);
    },
  );

  it('unsubscribe stops further notifications', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    const unsubscribe = notifying.subscribe(['medicines'], listener);

    await notifying.transaction(['medicines'], async (tx) => tx.put('medicines', { id: 'm1' }));
    unsubscribe();
    await notifying.transaction(['medicines'], async (tx) => tx.put('medicines', { id: 'm1' }));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a listener watching multiple tables fires once even if several of its tables are touched', async () => {
    const { store } = makeFakeStore();
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    notifying.subscribe(['medicines', 'schedules'], listener);

    await notifying.transaction(['medicines', 'schedules', 'syncOutbox'], async (tx) => {
      await tx.put('medicines', { id: 'm1' });
    });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('propagates a thrown error from the inner transaction without notifying', async () => {
    const store: Store = {
      transaction: () => Promise.reject(new Error('boom')),
    };
    const notifying = new NotifyingStore(store);
    const listener = vi.fn();
    notifying.subscribe(['medicines'], listener);

    await expect(
      notifying.transaction(['medicines'], async (tx) => tx.put('medicines', { id: 'm1' })),
    ).rejects.toThrow('boom');
    expect(listener).not.toHaveBeenCalled();
  });
});
