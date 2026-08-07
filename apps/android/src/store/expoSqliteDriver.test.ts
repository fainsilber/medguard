import { describe, expect, it } from 'vitest';
import type { SQLiteDatabase } from 'expo-sqlite';
import { ExpoSqliteDriver } from './expoSqliteDriver.js';

/**
 * A fake `SQLiteDatabase` that rejects a `withTransactionAsync` call made while another is still
 * open — exactly the real `expo-sqlite` behavior a live device hit ("cannot start a transaction
 * within a transaction", `apps/android/src/store/expoSqliteDriver.ts`'s driver-level comment).
 * `ExpoSqliteDriver.withTransaction()`'s queue is the thing this test proves: two independent
 * callers (standing in for e.g. the sync engine and a `useLiveQuery` refetch it triggers) must
 * never both be "inside" this fake's transaction at once.
 */
function fakeDb(): SQLiteDatabase {
  let active = false;
  return {
    async withTransactionAsync(task: () => Promise<void>) {
      if (active) {
        throw new Error(
          "Call to function 'NativeDatabase.execAsync' has been rejected.\n" +
            '→ Caused by: cannot start a transaction within a transaction',
        );
      }
      active = true;
      try {
        await task();
      } finally {
        active = false;
      }
    },
    async runAsync() {
      return { changes: 0, lastInsertRowId: 0 };
    },
    async getAllAsync() {
      return [];
    },
  } as unknown as SQLiteDatabase;
}

describe('ExpoSqliteDriver.withTransaction', () => {
  it('serializes overlapping calls instead of letting them race the single connection', async () => {
    const driver = new ExpoSqliteDriver(fakeDb());
    let active = 0;
    let maxActive = 0;

    const transact = () =>
      driver.withTransaction(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active -= 1;
        return null;
      });

    await Promise.all([transact(), transact(), transact()]);

    expect(maxActive).toBe(1);
  });

  it('still runs a later transaction after an earlier one throws, rather than wedging the queue', async () => {
    const driver = new ExpoSqliteDriver(fakeDb());

    await expect(
      driver.withTransaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(driver.withTransaction(async () => 'ok')).resolves.toBe('ok');
  });
});
