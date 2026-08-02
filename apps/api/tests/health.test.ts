import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('GET /api/v1/health', () => {
  it('reports D1 migrated and the Durable Object reachable', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'ok',
      d1: { migrated: true, schemaVersion: '1' },
      durableObject: { reachable: true, storage: 'sqlite' },
    });
  });

  it('reports the database as unmigrated when the schema row is missing', async () => {
    // A health check that always says "ok" is worse than none. This proves it actually
    // detects a database that has not been migrated, rather than reporting green regardless.
    await env.DB.prepare('DELETE FROM schema_meta WHERE key = ?').bind('schema_version').run();

    const response = await SELF.fetch('https://example.com/api/v1/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      d1: { migrated: false, schemaVersion: null },
    });
  });

  it('returns a structured 404 for unknown routes', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/nope');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'not_found' });
  });
});

describe('HouseholdDO', () => {
  it('is SQLite-backed, so it runs on the Cloudflare free plan', async () => {
    // storage.sql only exists on SQLite-backed Durable Objects. If wrangler.jsonc ever
    // regressed from new_sqlite_classes to new_classes, this is what would catch it.
    const id = env.HOUSEHOLD.idFromName('sqlite-check');
    const stub = env.HOUSEHOLD.get(id);

    await runInDurableObject(stub, (instance, state) => {
      expect(state.storage.sql).toBeDefined();
      expect(instance).toBeDefined();
    });
  });

  it('persists state across calls within the same object', async () => {
    const id = env.HOUSEHOLD.idFromName('counter');
    const stub = env.HOUSEHOLD.get(id);

    await expect(stub.ping()).resolves.toMatchObject({ hits: 1 });
    await expect(stub.ping()).resolves.toMatchObject({ hits: 2 });
  });

  it('keeps separate households isolated from each other', async () => {
    // The household is the unit of consistency and of authorization. Two ids must never
    // share storage.
    const a = env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName('household-a'));
    const b = env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName('household-b'));

    await a.ping();
    await a.ping();

    await expect(b.ping()).resolves.toMatchObject({ hits: 1 });
  });
});
