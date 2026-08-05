import { Dexie, type Table } from 'dexie';
import type { IntakeLog, Inventory, Medicine, Schedule, ShabbatConfig, SyncOutbox } from '@medguard/shared';

export class AndroidMedGuardDB extends Dexie {
  medicines!: Table<Medicine>;
  schedules!: Table<Schedule>;
  intakeLogs!: Table<IntakeLog>;
  inventory!: Table<Inventory>;
  shabbatConfig!: Table<ShabbatConfig>;
  syncOutbox!: Table<SyncOutbox>;

  constructor() {
    super('AndroidMedGuardDB');
    this.version(1).stores({
      medicines: 'id, patientId, name, syncStatus, updatedAt',
      schedules: 'id, medicineId, patientId, active, syncStatus, updatedAt',
      intakeLogs: 'id, patientId, medicineId, scheduleId, status, type, actualTime, syncStatus',
      inventory: 'id, medicineId, syncStatus, updatedAt',
      shabbatConfig: 'id, patientId',
      syncOutbox: '++id, table, entityId, action, createdAt',
    });
  }
}

export const androidDb = new AndroidMedGuardDB();
