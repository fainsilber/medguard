import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach } from 'vitest';
import { runRepositoryConformanceSuite } from '../testing/repositoryConformance.js';
import { DexieStore } from './dexieStore.js';

/**
 * A minimal local mirror of `apps/web/src/db/schema.ts`'s version-2 `stores()` block —
 * duplicated rather than imported so `packages/store` never depends on an app (the same reason
 * `sqlite/schema.ts` defines its own table list rather than reading Dexie's). Keeping the two in
 * sync is a manual step; a real drift would show up immediately as a conformance-suite failure
 * the moment a test exercises the missing index.
 */
class ConformanceTestDB extends Dexie {
  constructor(name: string) {
    super(name);
    this.version(1).stores({
      householdSettings: 'id',
      medicines: 'id, patientId, name, archived, syncStatus, updatedAt',
      schedules: 'id, medicineId, patientId, active, regimenGroupId, syncStatus, updatedAt',
      intakeLogs:
        'id, patientId, medicineId, scheduleId, status, type, actualTime, syncStatus, supersedesId, [medicineId+actualTime], [patientId+actualTime]',
      inventoryItems: 'id, medicineId, syncStatus, updatedAt',
      inventoryAdjustments: 'id, medicineId, relatedLogId, createdAt, syncStatus',
      shabbatConfig: 'id, patientId',
      syncOutbox: '++id, table, entityId, action, createdAt',
      syncMeta: 'key',
    });
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

runRepositoryConformanceSuite('Dexie', () => {
  const db = new ConformanceTestDB(`store-conformance-${++counter}`);
  openDatabases.push(db);
  return new DexieStore(db);
});
