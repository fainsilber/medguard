import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/**
 * The migrations are already exercised implicitly — every test file applies them into its own
 * isolated D1 before running. These assert the properties that a silently-wrong migration would
 * otherwise only reveal in production, on real medical data.
 */

async function tableInfo(table: string) {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>();
  return results;
}

const HOUSEHOLD_SCOPED_TABLES = [
  'household_settings',
  'medicines',
  'schedules',
  'intake_logs',
  'inventory_items',
  'inventory_adjustments',
  'dose_snoozes',
  'shabbat_config',
];

describe('migrations', () => {
  it('creates every table the domain needs', async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = results.map((row) => row.name);

    for (const table of [
      'households',
      'users',
      'devices',
      'join_codes',
      'join_attempts',
      ...HOUSEHOLD_SCOPED_TABLES,
    ]) {
      expect(names).toContain(table);
    }
  });

  it('records the schema version it applied', async () => {
    const row = await env.DB.prepare('SELECT value FROM schema_meta WHERE key = ?')
      .bind('schema_version')
      .first<{ value: string }>();

    expect(row?.value).toBe('3');
  });

  it.each(HOUSEHOLD_SCOPED_TABLES)(
    '%s carries household_id and seq — the authorization boundary and the sync cursor',
    async (table) => {
      const columns = (await tableInfo(table)).map((column) => column.name);

      // Without household_id there is no boundary between two families' medical data; without
      // seq a delta pull cannot be ordered, and a record can be skipped forever.
      expect(columns).toContain('household_id');
      expect(columns).toContain('seq');
      expect(columns).toContain('payload');
    },
  );

  it('never stores a join code or a device token in plaintext', async () => {
    const joinCodeColumns = (await tableInfo('join_codes')).map((column) => column.name);
    const deviceColumns = (await tableInfo('devices')).map((column) => column.name);

    expect(joinCodeColumns).toContain('code_hash');
    expect(joinCodeColumns).not.toContain('code');
    expect(deviceColumns).toContain('token_hash');
    expect(deviceColumns).not.toContain('token');
  });

  it('defaults a device to web push, so a native client can register FCM without a migration', async () => {
    const pushProvider = (await tableInfo('devices')).find(
      (column) => column.name === 'push_provider',
    );

    expect(pushProvider?.dflt_value).toContain('webpush');
    expect((await tableInfo('devices')).map((c) => c.name)).toContain('push_credentials');
  });

  it('cascades a household delete through its scoped data, leaving no orphaned medical records', async () => {
    await env.DB.prepare('PRAGMA foreign_keys = ON').run();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)').bind(
        'h1',
        'Test',
        '2026-08-03T00:00:00.000Z',
      ),
      env.DB.prepare(
        'INSERT INTO users (id, household_id, display_name, created_at) VALUES (?, ?, ?, ?)',
      ).bind('u1', 'h1', 'Mom', '2026-08-03T00:00:00.000Z'),
    ]);

    await env.DB.prepare('DELETE FROM households WHERE id = ?').bind('h1').run();

    const remaining = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE household_id = ?')
      .bind('h1')
      .first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it('enforces one settings row per household', async () => {
    await env.DB.prepare('INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)')
      .bind('h2', 'Test', '2026-08-03T00:00:00.000Z')
      .run();

    const insert = () =>
      env.DB.prepare(
        `INSERT INTO household_settings
           (id, household_id, seq, time_zone, escalation_after_mins, snooze_mins, updated_at, updated_by_device_id, payload)
         VALUES ('household', ?, 1, 'Asia/Jerusalem', 15, 15, '2026-08-03T00:00:00.000Z', 'd1', '{}')`,
      )
        .bind('h2')
        .run();

    await insert();
    await expect(insert()).rejects.toThrow();
  });
});
