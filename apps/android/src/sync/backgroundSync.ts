import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { SyncApiError, SyncEngine, PendingActionApplier } from '@medguard/store';
import * as MedGuardAlarms from '../../modules/medguard-alarms/src';
import { getApiBaseUrl, loadApiBaseUrlOverride } from '../api/config.js';
import * as syncApi from '../api/syncApi.js';
import { getHouseholdSession } from '../identity/session.js';
import { appLog } from '../logging/appLog.js';
import { deviceClock, deviceIdGenerator } from '../runtime/deviceRuntime.js';
import { openHeadlessRepository } from '../store/openHeadlessRepository.js';
import { getSyncIntervalMinutes } from './syncInterval.js';

const log = appLog('bg-sync');

/**
 * Periodic sync while the app is closed.
 *
 * Android's WorkManager (through `expo-background-task`) wakes the app's JS roughly every
 * interval the caregiver chose in Settings (`syncInterval.ts`; 15 minutes by default, which is also
 * the platform's floor — Doze or an OEM battery manager may delay a run further, which is
 * acceptable: local alarms never depend on sync). The worker survives the app being killed and the
 * phone rebooting.
 *
 * Each run does one round and stops. There is no in-task retry: the next scheduled run is the
 * retry. The task must never throw (an unhandled rejection in a background worker is a crash on
 * a locked phone), so every failure is logged and reported to the worker as `Failed`.
 */
export const BACKGROUND_SYNC_TASK = 'MedGuardBackgroundSync';

type SyncRunner = () => Promise<void>;
let foregroundRunner: SyncRunner | null = null;

/**
 * `SyncProvider` registers its own sync here while mounted. When the worker's JS runs inside a
 * process that already has a live app, going through the provider's engine avoids two
 * `SyncEngine`s writing the same database and keeps the badge truthful. `null` unregisters.
 */
export function setForegroundSyncRunner(runner: SyncRunner | null): void {
  foregroundRunner = runner;
}

/** One background round. Resolves `true` when there was nothing to do or the round succeeded. */
export async function runBackgroundSync(): Promise<boolean> {
  try {
    if (foregroundRunner) {
      await foregroundRunner();
      return true;
    }

    const session = await getHouseholdSession();
    if (!session) {
      log.debug('background sync skipped — no household on this device');
      return true;
    }

    const opened = await openHeadlessRepository();
    if (!opened) {
      // No caregiver identified (safety invariant 5) — leave the work for the next app launch.
      log.debug('background sync skipped — no caregiver identified on this device');
      return true;
    }
    const { store, repository, userId, deviceId } = opened;

    // Convert any captured Taken/Snooze taps first, so they reach the outbox and go out in this
    // very round rather than waiting for the next one.
    await new PendingActionApplier({
      repository,
      source: MedGuardAlarms,
      clock: deviceClock,
      ids: deviceIdGenerator,
      userId,
      deviceId,
      log,
    }).applyPendingActions();

    // No `RepositoryProvider` ran in this process, so load the persisted API URL override
    // ourselves — otherwise a device pointed at a dev server would sync to production.
    await loadApiBaseUrlOverride();
    await new SyncEngine({
      store,
      repository,
      api: syncApi,
      apiBaseUrl: getApiBaseUrl(),
      deviceToken: session.deviceToken,
      householdId: session.householdId,
      log,
    }).runOnce();
    log.debug('background sync finished');
    return true;
  } catch (error: unknown) {
    const revoked = error instanceof SyncApiError && error.code === 'unauthorized';
    log.error(revoked ? 'background sync failed: device revoked' : 'background sync failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Must run at module scope in `index.ts` — Expo needs the task defined before the worker starts
 * the JS bundle, which happens before any component renders.
 */
export function defineBackgroundSyncTask(): void {
  TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () =>
    (await runBackgroundSync())
      ? BackgroundTask.BackgroundTaskResult.Success
      : BackgroundTask.BackgroundTaskResult.Failed,
  );
}

// Register/unregister can be triggered from several places at once (provider mount, a Settings
// change); running them one at a time keeps the check-then-act below from interleaving.
let scheduling: Promise<void> = Promise.resolve();
function serialized(task: () => Promise<void>): Promise<void> {
  const next = scheduling.then(task, task);
  scheduling = next.catch(() => {});
  return next;
}

/**
 * Schedules the periodic task at the interval chosen in Settings; "Off" unregisters it. Idempotent
 * and never throws — a device that can't schedule background work still syncs in the foreground.
 *
 * Deliberately does nothing when the task is already scheduled at that interval: Android's
 * scheduler cancels and re-enqueues on every registration, which restarts the countdown. Calling
 * this on each app start would mean a once-a-day interval never fires for someone who opens the
 * app daily.
 */
export function registerBackgroundSync(): Promise<void> {
  return serialized(async () => {
    try {
      const minutes = await getSyncIntervalMinutes();
      if (minutes === 0) {
        await unregisterNow();
        return;
      }
      const status = await BackgroundTask.getStatusAsync();
      if (status === BackgroundTask.BackgroundTaskStatus.Restricted) {
        log.warn('background sync unavailable — background tasks are restricted on this device');
        return;
      }
      if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) {
        const options = await TaskManager.getTaskOptionsAsync<{ minimumInterval?: number } | null>(
          BACKGROUND_SYNC_TASK,
        );
        if (options?.minimumInterval === minutes) {
          return;
        }
        await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
      }
      await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, { minimumInterval: minutes });
      log.debug('background sync scheduled', { minutes });
    } catch (error: unknown) {
      log.warn('could not register background sync', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function unregisterNow(): Promise<void> {
  if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
  }
}

export function unregisterBackgroundSync(): Promise<void> {
  return serialized(async () => {
    try {
      await unregisterNow();
    } catch (error: unknown) {
      log.warn('could not unregister background sync', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
