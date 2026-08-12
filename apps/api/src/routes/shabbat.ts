import { Hono } from 'hono';
import { computeShabbatWindows, systemClock } from '@medguard/shared';
import type { HouseholdSettings, ShabbatConfig, ShabbatWindow } from '@medguard/shared';
import { requireDevice } from '../auth/middleware.js';
import type { AuthedEnv } from '../auth/middleware.js';

/**
 * Server-computed zmanim, Sprint 6.
 *
 * One route, two consumers: the web/native **verification screen** ("the next 8 weeks so you can
 * check against your luach before trusting it" — sprint plan exit gate), and the eventual device
 * sync of a horizon it can arm local alarms from with no network (`docs/android-client-plan.md`
 * "Shabbat on native"). Both want the same answer, computed once, here — never re-derived
 * on-device (cross-cutting rule 5).
 */
export const shabbatRoutes = new Hono<AuthedEnv>();

shabbatRoutes.use('*', requireDevice);

const DEFAULT_WEEKS = 8;
const MAX_WEEKS = 26;
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

/**
 * Every window over the next `weeks` (default 8, matching the sprint plan's verification
 * requirement), or an honest explanation of why there are none yet.
 *
 * Computed regardless of `autoShabbatEnabled` — the whole point of the verification screen is to
 * check zmanim *before* trusting automation with it, so an opted-out household must still be able
 * to see what the computation would produce.
 */
shabbatRoutes.get('/zmanim', async (c) => {
  const { householdId } = c.get('auth');

  const weeksParam = Number(c.req.query('weeks') ?? DEFAULT_WEEKS);
  const weeks = Number.isFinite(weeksParam)
    ? Math.min(MAX_WEEKS, Math.max(1, Math.trunc(weeksParam)))
    : DEFAULT_WEEKS;

  const [settingsRow, configRow] = await Promise.all([
    c.env.DB.prepare('SELECT payload FROM household_settings WHERE household_id = ?')
      .bind(householdId)
      .first<{ payload: string }>(),
    c.env.DB.prepare('SELECT payload FROM shabbat_config WHERE household_id = ? LIMIT 1')
      .bind(householdId)
      .first<{ payload: string }>(),
  ]);

  // Same fail-closed reasoning as the alarm chain's own `readWindows`: a guessed timezone would
  // silently compute the wrong hour, so this reports "not configured yet" rather than a number
  // that looks trustworthy but isn't.
  if (!settingsRow) {
    return c.json({ configured: false, reason: 'no_timezone' as const, windows: [] });
  }
  if (!configRow) {
    return c.json({ configured: false, reason: 'no_shabbat_config' as const, windows: [] });
  }

  const settings = JSON.parse(settingsRow.payload) as HouseholdSettings;
  const config = JSON.parse(configRow.payload) as ShabbatConfig;

  const nowMs = systemClock.nowMs();
  const windows: ShabbatWindow[] = computeShabbatWindows(config, settings.timeZone, {
    fromMs: nowMs,
    toMs: nowMs + weeks * MS_PER_WEEK,
  });

  return c.json({
    configured: true,
    autoShabbatEnabled: config.autoShabbatEnabled,
    timeZone: settings.timeZone,
    windows,
  });
});
