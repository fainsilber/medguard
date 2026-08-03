import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { systemClock } from '@medguard/shared';
import { authRoutes } from './routes/auth.js';
import { probeRoutes } from './routes/probe.js';
import { syncRoutes } from './routes/sync.js';

export { HouseholdDO } from './do/HouseholdDO.js';

const app = new Hono<{ Bindings: Env }>();

// The PWA is served from Pages and the API from Workers, so they are different origins.
app.use('/api/*', cors({ origin: (origin) => origin, credentials: true }));

/**
 * Liveness plus a real check of both stateful bindings: D1 (migrations applied) and the
 * Durable Object (reachable, SQLite-backed). A health endpoint that only returns 200 would
 * not have caught a KV-vs-SQLite misconfiguration.
 */
app.get('/api/v1/health', async (c) => {
  const meta = await c.env.DB.prepare('SELECT value FROM schema_meta WHERE key = ?')
    .bind('schema_version')
    .first<{ value: string }>();

  const stub = c.env.HOUSEHOLD.get(c.env.HOUSEHOLD.idFromName('health-check'));
  const durableObject = await stub.ping();

  return c.json({
    status: 'ok',
    d1: { migrated: meta !== null, schemaVersion: meta?.value ?? null },
    durableObject: { reachable: durableObject.ok, storage: durableObject.storage },
  });
});

/**
 * Authoritative time, for the client's clock-skew guard (delta D7).
 *
 * A device with a wrong clock cannot prove a cooldown has elapsed, so the client compares its own
 * reading against this and fails closed when they disagree by more than the tolerance. Kept
 * deliberately unauthenticated and free of any database work: it must stay cheap and it must keep
 * answering even when everything else is degraded, because the safe-to-dose decision depends on it.
 */
app.get('/api/v1/time', (c) => {
  return c.json({ nowIso: systemClock.nowIso(), nowMs: systemClock.nowMs() });
});

app.route('/api/v1', authRoutes);
app.route('/api/v1/sync', syncRoutes);
app.route('/api/v1/probe', probeRoutes);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;
