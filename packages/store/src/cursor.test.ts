import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieStore } from './dexie/dexieStore.js';
import { getCursor, getLastSyncedAt, setCursor, setLastSyncedAt } from './cursor.js';

class TestDB extends Dexie {
  constructor(name: string) {
    super(name);
    this.version(1).stores({ syncMeta: 'key' });
  }
}

let counter = 0;
const openDatabases: { delete(): Promise<unknown> }[] = [];

afterEach(async () => {
  for (const db of openDatabases) {
    await db.delete();
  }
  openDatabases.length = 0;
});

function freshStore() {
  const db = new TestDB(`cursor-test-${++counter}`);
  openDatabases.push(db);
  return new DexieStore(db);
}

describe('cursor', () => {
  it('is absent before any cursor is stored', async () => {
    const store = freshStore();
    expect(await getCursor(store, 'household-1')).toBeUndefined();
  });

  it('round-trips the cursor for the same household', async () => {
    const store = freshStore();
    await setCursor(store, 'household-1', 42);
    expect(await getCursor(store, 'household-1')).toBe(42);
  });

  it('treats a stored cursor for a different household as absent, self-healing across a household switch', async () => {
    const store = freshStore();
    await setCursor(store, 'household-1', 42);
    expect(await getCursor(store, 'household-2')).toBeUndefined();
  });
});

describe('lastSyncedAt', () => {
  it('is absent on a device that has never completed a pull', async () => {
    // Absent must be distinguishable from old: a device that has never synced cannot claim its
    // local data is fresh, and the staleness derivation treats `undefined` as "unknown, say so".
    const store = freshStore();
    expect(await getLastSyncedAt(store)).toBeUndefined();
  });

  it('round-trips the instant of the last successful pull', async () => {
    const store = freshStore();
    await setLastSyncedAt(store, '2026-06-15T12:00:00.000Z');
    expect(await getLastSyncedAt(store)).toBe('2026-06-15T12:00:00.000Z');
  });

  it('overwrites rather than accumulating — only the most recent contact matters', async () => {
    const store = freshStore();
    await setLastSyncedAt(store, '2026-06-15T12:00:00.000Z');
    await setLastSyncedAt(store, '2026-06-15T13:00:00.000Z');
    expect(await getLastSyncedAt(store)).toBe('2026-06-15T13:00:00.000Z');
  });

  it('is stored separately from the cursor, so neither clobbers the other', async () => {
    const store = freshStore();
    await setCursor(store, 'household-1', 42);
    await setLastSyncedAt(store, '2026-06-15T12:00:00.000Z');

    expect(await getCursor(store, 'household-1')).toBe(42);
    expect(await getLastSyncedAt(store)).toBe('2026-06-15T12:00:00.000Z');
  });
});
