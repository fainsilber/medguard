import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { probeRoutes } from './routes/probe.js';

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

app.route('/api/v1/probe', probeRoutes);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;
