import { MS_PER_DAY, toIso } from '@medguard/shared';
import type { HouseholdSettings, ShabbatConfig, ShabbatWindow } from '@medguard/shared';
import { applyRecord } from '../sync/repository.js';
import { computeWindows } from './zmanim.js';

/**
 * Publishing computed Shabbat windows into the household's synced data (Sprint A5).
 *
 * The windows are written through `applyRecord`, exactly as an uploaded record would be, so they
 * pick up a `seq` and reach every device through the pull every client already runs. No new
 * channel, no push, no polling: a phone learns when Shabbat starts the same way it learns about a
 * new medicine.
 *
 * Republishing is idempotent by construction. A window's id is derived from its own start
 * (`shabbat:<startsAt>`), so recomputing the same calendar produces the same ids, and LWW turns
 * the second write into a no-op rather than a duplicate. That is what allows this to be called
 * freely — on every config change, and whenever the rolling horizon runs short — without any
 * bookkeeping about what has already been published.
 */

/**
 * How far ahead windows are published.
 *
 * Comfortably more than the eight weeks the verification screen shows (so a caregiver checking
 * against a luach never runs off the end of the list), and comfortably more than a device is
 * likely to go without syncing.
 */
export const PUBLISH_HORIZON_MS = 90 * MS_PER_DAY;

/**
 * Republish once the furthest published window is nearer than this.
 *
 * A month of slack: the horizon is topped up long before a device could reach the end of what it
 * has, even if nobody opens the app and nothing changes in the household for weeks.
 */
export const PUBLISH_REFRESH_THRESHOLD_MS = 30 * MS_PER_DAY;

/** Windows older than this are deleted — the reconciliation they belonged to is long done. */
const RETAIN_PAST_MS = 30 * MS_PER_DAY;

/**
 * Attributed to `server`, honestly: no device computed these, and `updatedByDeviceId` is what
 * breaks LWW ties. A device id here would be a lie that could also lose a tie against a real one.
 */
const SERVER_DEVICE_ID = 'server';

async function readConfig(
  db: D1Database,
  householdId: string,
): Promise<ShabbatConfig | undefined> {
  const row = await db
    .prepare('SELECT payload FROM shabbat_config WHERE household_id = ? ORDER BY seq DESC LIMIT 1')
    .bind(householdId)
    .first<{ payload: string }>();

  return row ? (JSON.parse(row.payload) as ShabbatConfig) : undefined;
}

async function readTimeZone(db: D1Database, householdId: string): Promise<string | undefined> {
  const row = await db
    .prepare('SELECT payload FROM household_settings WHERE household_id = ?')
    .bind(householdId)
    .first<{ payload: string }>();

  return row ? (JSON.parse(row.payload) as HouseholdSettings).timeZone : undefined;
}

/** The furthest-out published window's end, or `undefined` when nothing has been published. */
export async function furthestPublishedMs(
  db: D1Database,
  householdId: string,
): Promise<number | undefined> {
  const row = await db
    .prepare('SELECT MAX(ends_at) AS ends_at FROM shabbat_windows WHERE household_id = ?')
    .bind(householdId)
    .first<{ ends_at: string | null }>();

  return row?.ends_at ? new Date(row.ends_at).getTime() : undefined;
}

/**
 * Recomputes and publishes the household's windows for the next `PUBLISH_HORIZON_MS`.
 *
 * Does nothing without a `ShabbatConfig` (nothing to compute from) or without household settings
 * (no timezone, and every candle-lighting time is displayed and reasoned about in the household's
 * own zone). Both are the same fail-closed rule the alarm chain already follows: publish nothing
 * rather than publish something computed from a guess.
 *
 * Returns the number of windows written, so callers and tests can tell "published nothing because
 * there was nothing to publish" from "published nothing because it had already been done".
 */
export async function publishWindows(
  db: D1Database,
  householdId: string,
  nowMs: number,
): Promise<number> {
  const [config, timeZone] = await Promise.all([
    readConfig(db, householdId),
    readTimeZone(db, householdId),
  ]);

  if (!config || !timeZone) {
    return 0;
  }

  const windows = computeWindows(config, timeZone, {
    fromMs: nowMs,
    toMs: nowMs + PUBLISH_HORIZON_MS,
  });

  const generatedAt = toIso(nowMs);

  for (const window of windows) {
    const record: ShabbatWindow = {
      ...window,
      patientId: config.patientId,
      generatedAt,
      updatedAt: generatedAt,
      updatedByDeviceId: SERVER_DEVICE_ID,
      syncStatus: 'synced',
    };
    await applyRecord(db, householdId, 'shabbatWindows', record as unknown as Record<string, unknown>);
  }

  // Windows well past are dropped rather than kept forever: a device pulling from scratch should
  // not be handed years of history it can do nothing with. A month of slack keeps anything a
  // Motzei reconciliation could still be working through.
  await db
    .prepare('DELETE FROM shabbat_windows WHERE household_id = ? AND ends_at < ?')
    .bind(householdId, toIso(nowMs - RETAIN_PAST_MS))
    .run();

  return windows.length;
}

/**
 * Publishes only if the horizon has run short.
 *
 * Called from the alarm chain's materialization, which happens on every household write and every
 * chain wake — so a household that set its coordinates once and never touched them again still
 * has windows, without recomputing 90 days of calendar on every dose.
 */
export async function publishWindowsIfStale(
  db: D1Database,
  householdId: string,
  nowMs: number,
): Promise<number> {
  const furthest = await furthestPublishedMs(db, householdId);
  if (furthest !== undefined && furthest - nowMs > PUBLISH_REFRESH_THRESHOLD_MS) {
    return 0;
  }
  return publishWindows(db, householdId, nowMs);
}
