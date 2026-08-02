import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import type { Table } from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Harness proof only: confirms Dexie runs against fake-indexeddb under vitest, so Sprint 1 can
 * test the real schema and repositories without a browser. The real MedGuardDB lands in Sprint 1.
 */
interface Row {
  id: string;
  value: number;
}

class HarnessDB extends Dexie {
  rows!: Table<Row, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({ rows: 'id' });
  }
}

let db: HarnessDB | undefined;

afterEach(async () => {
  if (db) {
    await db.delete();
    db = undefined;
  }
});

describe('dexie + fake-indexeddb harness', () => {
  it('persists and reads back a record', async () => {
    db = new HarnessDB('harness-read-write');
    await db.rows.put({ id: 'a', value: 1 });

    await expect(db.rows.get('a')).resolves.toEqual({ id: 'a', value: 1 });
  });

  it('rolls a failed transaction back completely', async () => {
    // Sprint 1 relies on this: a mutation and its syncOutbox entry are written in one
    // transaction, so a failure must never leave an orphan outbox row.
    db = new HarnessDB('harness-rollback');
    await db.rows.put({ id: 'a', value: 1 });

    await expect(
      db.transaction('rw', db.rows, async () => {
        await db!.rows.put({ id: 'b', value: 2 });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(db.rows.get('b')).resolves.toBeUndefined();
    await expect(db.rows.count()).resolves.toBe(1);
  });
});
