import type { PendingActionEvent, PendingActionRecord, PendingActionSource } from '@medguard/store';

/**
 * The web's answer to Android's `pending_actions` table: where a lock-screen tap is parked
 * between the service worker capturing it and the app converting it into a dose.
 *
 * A service worker must not write the ledger itself (delta AD2, applied to the web). It could —
 * IndexedDB is available to it — but that would be a second implementation of the transaction
 * that writes a log, an inventory adjustment and two outbox rows together, in a context with no
 * repository, no clock injection and no way to run the safety checks. So the worker records
 * *intent*, durably, the instant the tap happens, and `PendingActionApplier` converts it.
 *
 * Deliberately raw IndexedDB rather than Dexie: this module is imported by the service worker
 * bundle, where the app's whole schema and its migrations have no business being. It is also a
 * separate database from the app's, so a "clear all local data" wipe of the medical record does
 * not silently delete a tap that has not been applied yet.
 *
 * Peek/ack rather than a destructive drain, matching `PendingActionStore.kt` and for the same
 * reason: if the page is closed between reading a tap and writing the resulting log, a
 * read-and-clear API would have lost the dose with nothing on disk to retry (invariant 7).
 */

const DB_NAME = 'medguard-pending-actions';
const DB_VERSION = 1;
const STORE_NAME = 'actions';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the pending-action store'));
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const request = work(transaction.objectStore(STORE_NAME));
        transaction.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error ?? new Error('pending-action store transaction failed'));
        };
      }),
  );
}

/**
 * Records one tap. Called from the service worker, inside the `notificationclick` handler's
 * `waitUntil`, so the write is durable before the worker is allowed to go idle.
 */
export async function recordPendingAction(
  event: PendingActionEvent & { id: string },
): Promise<void> {
  await withStore('readwrite', (store) => store.put(event));
}

export const webPendingActionSource: PendingActionSource = {
  async readPendingActions(): Promise<PendingActionRecord[]> {
    return withStore<PendingActionRecord[]>('readonly', (store) =>
      store.getAll() as IDBRequest<PendingActionRecord[]>,
    );
  },

  async ackPendingActions(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await openDatabase().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(STORE_NAME, 'readwrite');
          const store = transaction.objectStore(STORE_NAME);
          for (const id of ids) {
            store.delete(id);
          }
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => {
            db.close();
            reject(transaction.error ?? new Error('could not acknowledge pending actions'));
          };
        }),
    );
  },
};
