import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * `fake-indexeddb/auto` gives the Dexie-backed screens a real IndexedDB implementation under
 * jsdom, which has none — the same arrangement `apps/web` uses, so both clients' component tests
 * exercise the actual database rather than a mock of it.
 */
afterEach(() => {
  cleanup();
});
