import { Hono } from 'hono';
import { z } from 'zod';
import { syncableTableSchema } from '@medguard/shared';
import { requireDevice } from '../auth/middleware.js';
import type { AuthedEnv } from '../auth/middleware.js';
import { PULL_PAGE_SIZE, currentCursor, readAll, readSince } from '../sync/repository.js';
import { TABLES } from '../sync/tables.js';

/**
 * The sync surface: a full snapshot for a new device, a cursor-based delta for an existing one,
 * and a batched idempotent upload.
 *
 * Every route is behind `requireDevice` and every query is scoped to the household resolved from
 * the token. No route reads a household id from the request.
 */
export const syncRoutes = new Hono<AuthedEnv>();

syncRoutes.use('*', requireDevice);

/** How many records one upload may carry. Bounded so a malformed or hostile client cannot ask the Worker to do unbounded work. */
const MAX_BATCH_SIZE = 500;

const pushSchema = z.object({
  changes: z
    .array(
      z.object({
        table: syncableTableSchema,
        // Validated against the table's own schema once we know which table it is — a payload can
        // only be checked meaningfully in the context of what it claims to be.
        record: z.record(z.string(), z.unknown()),
      }),
    )
    .max(MAX_BATCH_SIZE),
});

/**
 * Everything the household has, plus the cursor to resume from.
 *
 * Used when a device joins, or when it has been offline long enough that catching up by delta
 * would be slower than starting over.
 */
syncRoutes.get('/bootstrap', async (c) => {
  const { householdId } = c.get('auth');

  const [records, cursor] = await Promise.all([
    readAll(c.env.DB, householdId),
    currentCursor(c.env.DB, householdId),
  ]);

  return c.json({ cursor, records });
});

/**
 * Records written after `cursor`.
 *
 * `hasMore` tells a client that has been offline for a long time to pull again rather than assume
 * it is caught up — silently truncating at the page limit is how a device ends up permanently
 * missing a dose it never knew about.
 */
syncRoutes.get('/pull', async (c) => {
  const { householdId } = c.get('auth');

  const parsed = z.coerce.number().int().min(0).safeParse(c.req.query('cursor') ?? 0);
  if (!parsed.success) {
    return c.json({ error: 'invalid_cursor' }, 400);
  }

  const records = await readSince(c.env.DB, householdId, parsed.data);
  const cursor = records.length > 0 ? records[records.length - 1]!.seq : parsed.data;

  return c.json({
    cursor,
    records,
    hasMore: records.length === PULL_PAGE_SIZE,
  });
});

/**
 * Uploads a batch of local changes.
 *
 * Each change is validated here against its table's zod schema — the same schemas the client
 * uses, so a rule cannot drift between the two sides — and reported on individually. A record
 * that fails validation is rejected without stopping the rest of the batch: one malformed row
 * must not block a caregiver's other doses from syncing.
 *
 * The actual writes are delegated to the household's Durable Object rather than applied directly
 * against D1 here: a DO processes one call at a time, which is what serializes two caregivers'
 * concurrent PRN doses and makes the authoritative cooldown/cap re-check (delta D2) meaningful —
 * a check performed against a snapshot of D1 read from this Worker, with no serialization, could
 * still race. `blocked` covers both a genuine safety block and a data-integrity refusal (an
 * inventory adjustment whose dose log was never accepted); `rejected` is unrelated — a payload
 * that never had a valid shape to begin with, decided before the DO is ever involved.
 */
syncRoutes.post('/push', async (c) => {
  const { householdId } = c.get('auth');

  const body = await c.req.json().catch(() => null);
  const parsed = pushSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  const changes: { table: (typeof parsed.data.changes)[number]['table']; record: Record<string, unknown> }[] = [];
  const rejected: { table: string; id: string | null; issues: unknown }[] = [];

  for (const change of parsed.data.changes) {
    const config = TABLES[change.table];
    const validated = config.schema.safeParse(change.record);

    if (!validated.success) {
      rejected.push({
        table: change.table,
        id: typeof change.record.id === 'string' ? change.record.id : null,
        issues: validated.error.issues,
      });
      continue;
    }

    changes.push({ table: change.table, record: validated.data });
  }

  const stub = c.env.HOUSEHOLD.get(c.env.HOUSEHOLD.idFromName(householdId));
  const { cursor, results } = await stub.applyBatch(householdId, changes);

  return c.json({
    cursor,
    results: results.filter((result) => result.outcome !== 'blocked'),
    blocked: results
      .filter((result) => result.outcome === 'blocked')
      .map(({ table, id, blockedReason, availableAtIso, msRemaining }) => ({
        table,
        id,
        reason: blockedReason,
        ...(availableAtIso ? { availableAtIso } : {}),
        ...(msRemaining !== undefined ? { msRemaining } : {}),
      })),
    rejected,
  });
});
