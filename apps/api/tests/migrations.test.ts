import { env } from 'cloudflare:test';
import { SINGLE_PATIENT_ID } from '@medguard/shared';
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
  'patients',
  'medicine_patients',
  'medicines',
  'schedules',
  'intake_logs',
  'inventory_items',
  'inventory_adjustments',
  'dose_snoozes',
  'shabbat_config',
  'shabbat_windows',
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

    expect(row?.value).toBe('5');
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

/**
 * `0005_patients.sql`'s backfill only ever fires against a household that already has a medicine
 * at the moment the migration is applied — which every test file's fresh, empty D1 never does
 * (migrations run before any test inserts a row). So the backfill logic is re-run here, verbatim,
 * against a household seeded with a medicine *after* migrations have already applied, which is
 * the actual situation the backfill exists for: real households with real medicines, upgrading.
 */
async function runPatientBackfill(): Promise<void> {
  const statements = [
    `UPDATE households
       SET change_seq = change_seq + 1
       WHERE id IN (SELECT DISTINCT household_id FROM medicines)
         AND id NOT IN (SELECT household_id FROM patients WHERE id = '${SINGLE_PATIENT_ID}')`,
    `INSERT INTO patients (id, household_id, seq, display_name, archived, sort_order, updated_at, updated_by_device_id, payload)
       SELECT
         '${SINGLE_PATIENT_ID}', h.id, h.change_seq, 'Patient', 0, 0,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'server-backfill',
         json_object(
           'id', '${SINGLE_PATIENT_ID}', 'displayName', 'Patient', 'archived', json('false'),
           'sortOrder', 0, 'updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           'updatedByDeviceId', 'server-backfill', 'syncStatus', 'synced'
         )
       FROM households h
       WHERE h.id IN (SELECT DISTINCT household_id FROM medicines)
         AND h.id NOT IN (SELECT household_id FROM patients WHERE id = '${SINGLE_PATIENT_ID}')`,
    `UPDATE households
       SET change_seq = change_seq + (
         SELECT COUNT(*) FROM medicines m WHERE m.household_id = households.id
           AND (m.household_id || ':' || m.id) NOT IN (SELECT mp.household_id || ':' || mp.medicine_id FROM medicine_patients mp)
       )
       WHERE id IN (
         SELECT DISTINCT m.household_id FROM medicines m
         WHERE (m.household_id || ':' || m.id) NOT IN (SELECT mp.household_id || ':' || mp.medicine_id FROM medicine_patients mp)
       )`,
    `INSERT INTO medicine_patients (id, household_id, seq, medicine_id, patient_id, active, updated_at, updated_by_device_id, payload)
       SELECT
         m.id || ':' || '${SINGLE_PATIENT_ID}', m.household_id,
         h.change_seq - reserved.n + ROW_NUMBER() OVER (PARTITION BY m.household_id ORDER BY m.id),
         m.id, '${SINGLE_PATIENT_ID}', 1,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'server-backfill',
         json_object(
           'id', m.id || ':' || '${SINGLE_PATIENT_ID}', 'medicineId', m.id, 'patientId', '${SINGLE_PATIENT_ID}',
           'active', json('true'), 'updatedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
           'updatedByDeviceId', 'server-backfill', 'syncStatus', 'synced'
         )
       FROM medicines m
       JOIN households h ON h.id = m.household_id
       JOIN (
         SELECT m2.household_id, COUNT(*) AS n FROM medicines m2
         WHERE (m2.household_id || ':' || m2.id) NOT IN (SELECT mp.household_id || ':' || mp.medicine_id FROM medicine_patients mp)
         GROUP BY m2.household_id
       ) reserved ON reserved.household_id = m.household_id
       WHERE (m.household_id || ':' || m.id) NOT IN (SELECT mp.household_id || ':' || mp.medicine_id FROM medicine_patients mp)`,
  ];

  for (const sql of statements) {
    await env.DB.prepare(sql).run();
  }
}

describe('patient backfill (0005_patients.sql)', () => {
  async function seedHouseholdWithMedicine(householdId: string, medicineId: string) {
    await env.DB.prepare('INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)')
      .bind(householdId, 'Test', '2026-08-03T00:00:00.000Z')
      .run();
    await env.DB.prepare(
      `INSERT INTO medicines
         (id, household_id, seq, patient_id, name, as_needed, archived, updated_at, updated_by_device_id, payload)
       VALUES (?, ?, 1, ?, 'Ondansetron', 0, 0, '2026-08-03T00:00:00.000Z', 'd1', '{}')`,
    )
      .bind(medicineId, householdId, SINGLE_PATIENT_ID)
      .run();
  }

  it('gives a household with an existing medicine one patient and one assignment', async () => {
    await seedHouseholdWithMedicine('h-backfill-1', 'm-backfill-1');

    await runPatientBackfill();

    const patient = await env.DB.prepare('SELECT * FROM patients WHERE household_id = ?')
      .bind('h-backfill-1')
      .first<{ id: string; display_name: string; payload: string }>();
    expect(patient?.id).toBe(SINGLE_PATIENT_ID);
    expect(patient?.display_name).toBe('Patient');
    expect(JSON.parse(patient!.payload)).toMatchObject({
      id: SINGLE_PATIENT_ID,
      displayName: 'Patient',
      archived: false,
      syncStatus: 'synced',
    });

    const assignment = await env.DB.prepare('SELECT * FROM medicine_patients WHERE household_id = ?')
      .bind('h-backfill-1')
      .first<{ medicine_id: string; patient_id: string; payload: string }>();
    expect(assignment?.medicine_id).toBe('m-backfill-1');
    expect(assignment?.patient_id).toBe(SINGLE_PATIENT_ID);
    expect(JSON.parse(assignment!.payload)).toMatchObject({
      medicineId: 'm-backfill-1',
      patientId: SINGLE_PATIENT_ID,
      active: true,
      syncStatus: 'synced',
    });
  });

  it('never assigns two distinct seq values in a household to the same seq (no cursor collision)', async () => {
    await seedHouseholdWithMedicine('h-backfill-2', 'm-backfill-2a');
    await env.DB.prepare(
      `INSERT INTO medicines
         (id, household_id, seq, patient_id, name, as_needed, archived, updated_at, updated_by_device_id, payload)
       VALUES (?, ?, 2, ?, 'Paracetamol', 0, 0, '2026-08-03T00:00:00.000Z', 'd1', '{}')`,
    )
      .bind('m-backfill-2b', 'h-backfill-2', SINGLE_PATIENT_ID)
      .run();

    await runPatientBackfill();

    const { results } = await env.DB.prepare(
      `SELECT seq FROM patients WHERE household_id = ?
       UNION ALL
       SELECT seq FROM medicine_patients WHERE household_id = ?`,
    )
      .bind('h-backfill-2', 'h-backfill-2')
      .all<{ seq: number }>();
    const seqs = results.map((row) => row.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('is idempotent: running it twice does not duplicate the patient or the assignment', async () => {
    await seedHouseholdWithMedicine('h-backfill-3', 'm-backfill-3');

    await runPatientBackfill();
    await runPatientBackfill();

    const patients = await env.DB.prepare('SELECT COUNT(*) AS n FROM patients WHERE household_id = ?')
      .bind('h-backfill-3')
      .first<{ n: number }>();
    const assignments = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM medicine_patients WHERE household_id = ?',
    )
      .bind('h-backfill-3')
      .first<{ n: number }>();

    expect(patients?.n).toBe(1);
    expect(assignments?.n).toBe(1);
  });

  it('does nothing to a household with no medicines', async () => {
    await env.DB.prepare('INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)')
      .bind('h-backfill-4', 'Test', '2026-08-03T00:00:00.000Z')
      .run();

    await runPatientBackfill();

    const patients = await env.DB.prepare('SELECT COUNT(*) AS n FROM patients WHERE household_id = ?')
      .bind('h-backfill-4')
      .first<{ n: number }>();
    expect(patients?.n).toBe(0);
  });
});
