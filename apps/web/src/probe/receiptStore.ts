import type { ProbePushReceipt } from '@medguard/shared';

/**
 * Raw IndexedDB, not Dexie: this store is written from inside the service worker, where the
 * push actually arrives, and read from the page after the user reopens the app — the whole
 * point of the probe is testing delivery while nothing is open to receive a postMessage. Kept
 * deliberately separate from the Sprint 1 Dexie schema, since this is throwaway diagnostic
 * tooling (see ProbePage.tsx), not a table that belongs in the real domain database.
 */
const DB_NAME = 'medguard-probe';
const STORE_NAME = 'receipts';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'receivedAtIso' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error as DOMException);
  });
}

export async function saveReceipt(receipt: ProbePushReceipt): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(receipt);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as DOMException);
    });
  } finally {
    db.close();
  }
}

export async function getReceipts(): Promise<ProbePushReceipt[]> {
  const db = await openDb();
  try {
    const receipts = await new Promise<ProbePushReceipt[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const request = tx.objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as ProbePushReceipt[]);
      request.onerror = () => reject(request.error as DOMException);
    });
    return receipts.sort((a, b) => a.receivedAtIso.localeCompare(b.receivedAtIso));
  } finally {
    db.close();
  }
}

export async function clearReceipts(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error as DOMException);
    });
  } finally {
    db.close();
  }
}
