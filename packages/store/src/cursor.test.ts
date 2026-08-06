import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieStore } from './dexie/dexieStore.js';
import { getCursor, setCursor } from './cursor.js';

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
