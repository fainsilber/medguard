import { Hono } from 'hono';
import { resolveDevice } from '../auth/middleware.js';

/**
 * The WebSocket upgrade for a household's live channel.
 *
 * Deliberately its own router mounted at its own path (`/api/v1/live`), not folded into
 * `syncRoutes` at `/api/v1/sync/*`: Hono merges a sub-app's `.use('*', middleware)` into the
 * parent's routing table for its whole mount prefix, so nesting this under `/api/v1/sync` would
 * put it behind `syncRoutes`' blanket `requireDevice` — which reads the credential from an
 * `Authorization` header, and a browser's native WebSocket API cannot set one. This route
 * authenticates the same credential carried a different way — see `resolveDevice`'s docstring —
 * then hands the raw upgrade request to the household's Durable Object, which does the actual
 * `acceptWebSocket` and never sees or checks the token itself.
 */
export const liveRoutes = new Hono<{ Bindings: Env }>();

liveRoutes.get('/', async (c) => {
  const protocolHeader = c.req.header('Sec-WebSocket-Protocol');
  const token = protocolHeader?.split(',')[0]?.trim();
  const auth = await resolveDevice(c.env.DB, token);
  if (!auth) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'upgrade_required' }, 426);
  }

  const stub = c.env.HOUSEHOLD.get(c.env.HOUSEHOLD.idFromName(auth.householdId));
  return stub.fetch(c.req.raw);
});
