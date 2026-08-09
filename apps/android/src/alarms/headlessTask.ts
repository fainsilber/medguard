import * as SQLite from 'expo-sqlite';
import { MedGuardRepository, PendingActionApplier } from '@medguard/store';
import { SqliteStore } from '@medguard/store/sqlite';
import * as MedGuardAlarms from '../../modules/medguard-alarms/src';
import { getCaregiverName } from '../identity/caregiverName.js';
import { getOrCreateDeviceId } from '../identity/deviceId.js';
import { appLog } from '../logging/appLog.js';
import { deviceClock, deviceIdGenerator } from '../runtime/deviceRuntime.js';
import { ExpoSqliteDriver, createSqliteSchema } from '../store/expoSqliteDriver.js';

const log = appLog('headless');

/**
 * The JavaScript that runs when there is no app.
 *
 * `MedGuardHeadlessService` starts this after a "Taken" or "Snooze" tap that arrived with the app
 * process dead — the normal state for a phone that has been locked for hours. Sprint A3 left this
 * gap deliberately open: a tap was captured durably and then waited for the next app launch,
 * which cost only latency. Sprint A4 closes it, because latency now has a consequence — the
 * server escalates an unconfirmed dose to the other caregiver, and a dose that *was* given but
 * has not synced yet looks exactly like one that wasn't.
 *
 * Deliberately minimal. It opens the database, drains, and stops: no React, no navigation, no
 * sync engine, no live socket. The one thing it must do — convert a captured tap into an
 * `IntakeLog` through the same repository transaction the UI uses (delta AD2) — is the same
 * `PendingActionApplier` the foreground path runs, so there is no second implementation of the
 * ledger rules to drift.
 *
 * Nothing here is a `Provider`, so it is also the one place in this app that builds the
 * repository outside `RepositoryContext`. That duplication is real but small and unavoidable:
 * a headless task has no component tree to hang a context on.
 */
export async function runPendingActionsTask(): Promise<void> {
  try {
    const [userId, deviceId] = await Promise.all([getCaregiverName(), getOrCreateDeviceId()]);
    if (!userId) {
      // No caregiver has identified themselves on this device, so there is nobody to attribute a
      // dose to (safety invariant 5). The tap stays captured and is applied at the next launch,
      // where the app can ask.
      log.debug('headless drain skipped — no caregiver identified on this device');
      return;
    }

    const db = await SQLite.openDatabaseAsync('medguard.db');
    await createSqliteSchema(db);
    const store = new SqliteStore(new ExpoSqliteDriver(db));
    const repository = new MedGuardRepository(store, {
      clock: deviceClock,
      ids: deviceIdGenerator,
      userId,
      deviceId,
    });

    const applier = new PendingActionApplier({
      repository,
      source: MedGuardAlarms,
      clock: deviceClock,
      ids: deviceIdGenerator,
      userId,
      deviceId,
      log,
    });

    const applied = await applier.applyPendingActions();
    log.debug('headless drain finished', { applied });

    // Deliberately not syncing from here. The record is durable and in the outbox; pushing it
    // needs the household session, a network round trip and the sync engine's retry handling,
    // all inside a service Android may stop at any moment. The next app start — or the next
    // foreground — drains the outbox as it always does.
  } catch (error: unknown) {
    // Never throw out of a headless task: an unhandled rejection here is a native crash on a
    // locked phone, which is a far worse outcome than the tap waiting for the next app launch.
    log.error('headless drain failed', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
