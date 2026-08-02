
import { Hono } from 'hono';
import { SHABBAT_BURST_COUNT, SHABBAT_BURST_SPACING_MS, systemClock } from '@medguard/shared';
import type { ProbeNotificationOptions, ProbePushPayload } from '@medguard/shared';
import { readVapidConfig } from '../push/send.js';
import type { PushSubscription } from '../push/send.js';

/**
 * Endpoints backing the Sprint 0 capability probe.
 *
 * These exist to answer platform questions with evidence from real devices rather than from
 * the spec — above all whether a push actually arrives on a locked phone, which the entire
 * Shabbat design depends on. Deleted or folded into the real push routes in Sprint 5.
 */
export const probeRoutes = new Hono<{ Bindings: Env }>();

function isPushSubscription(value: unknown): value is PushSubscription {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PushSubscription>;
  return (
    typeof candidate.endpoint === 'string' &&
    typeof candidate.keys?.auth === 'string' &&
    typeof candidate.keys?.p256dh === 'string'
  );
}

probeRoutes.get('/vapid-public-key', (c) => {
  const vapid = readVapidConfig(c.env);
  if (!vapid) {
    return c.json({ error: 'vapid_not_configured' }, 503);
  }
  return c.json({ publicKey: vapid.publicKey });
});

/**
 * Schedules a burst of pushes after a delay, so the phone can be locked and put down first.
 * Defaults mirror the Shabbat alert: 3 pushes, 15s apart, sharing one tag with renotify.
 */
probeRoutes.post('/push', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  const {
    probeId,
    subscription,
    delaySeconds = 15,
    burstCount = SHABBAT_BURST_COUNT,
    spacingMs = SHABBAT_BURST_SPACING_MS,
    options = {},
  } = body as {
    probeId?: unknown;
    subscription?: unknown;
    delaySeconds?: number;
    burstCount?: number;
    spacingMs?: number;
    options?: ProbeNotificationOptions;
  };

  if (typeof probeId !== 'string' || probeId.length === 0) {
    return c.json({ error: 'probe_id_required' }, 400);
  }
  if (!isPushSubscription(subscription)) {
    return c.json({ error: 'invalid_subscription' }, 400);
  }
  if (!readVapidConfig(c.env)) {
    return c.json({ error: 'vapid_not_configured' }, 503);
  }

  const nowIso = systemClock.nowIso();
  const payloads: ProbePushPayload[] = Array.from({ length: burstCount }, (_, index) => ({
    kind: 'probe',
    title: 'MedGuard test alert',
    body:
      burstCount > 1
        ? `Shabbat burst ${index + 1} of ${burstCount} — no action needed`
        : 'Single push test — no action needed',
    sentAtIso: nowIso,
    burstIndex: index + 1,
    burstTotal: burstCount,
    // One shared tag plus renotify: the phone re-alerts without stacking N notifications.
    tag: 'medguard-probe',
    renotify: true,
    ...options,
  }));

  const stub = c.env.HOUSEHOLD.get(c.env.HOUSEHOLD.idFromName(`probe:${probeId}`));
  const scheduled = await stub.schedulePushBurst(
    subscription,
    payloads,
    delaySeconds * 1000,
    spacingMs,
  );

  return c.json({ ...scheduled, requestedAtIso: nowIso });
});

/**
 * What the server actually did. Lets the probe tell "the push was never sent" apart from
 * "the push was sent and the phone never showed it" — a distinction that is otherwise
 * invisible and would be guessed at.
 */
probeRoutes.get('/push-log/:probeId', async (c) => {
  const probeId = c.req.param('probeId');
  const stub = c.env.HOUSEHOLD.get(c.env.HOUSEHOLD.idFromName(`probe:${probeId}`));
  return c.json(await stub.getProbeLog());
});
