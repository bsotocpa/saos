// Test infrastructure: each suite run gets a FRESH database (dropped and
// recreated, migrated, seeded via @saos/db) so tests never touch dev data and
// audit-log immutability can't pollute anything that matters.

import argon2 from 'argon2';
import pg from 'pg';
import { migrate, seedAll } from '@saos/db';
import { loadConfig, type Config } from '../src/config.ts';
import { encryptSecret } from '../src/crypto.ts';

const TEST_DB = 'saos_api_test';

export async function createTestConfig(): Promise<Config> {
  const base = loadConfig({ NODE_ENV: 'test' });
  const url = new URL(base.DATABASE_URL);

  // Recreate the test database via the maintenance DB on the same server.
  const adminUrl = new URL(base.DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.end();
  }

  url.pathname = `/${TEST_DB}`;
  const testUrl = url.toString();

  await migrate(testUrl, 'up');
  const seeder = new pg.Client({ connectionString: testUrl });
  await seeder.connect();
  try {
    await seeder.query('BEGIN');
    await seedAll(seeder);
    await seeder.query('COMMIT');
  } finally {
    await seeder.end();
  }

  return loadConfig({ NODE_ENV: 'test', DATABASE_URL: testUrl });
}

export interface TestStaff {
  id: string;
  email: string;
  password: string;
  totpSecret?: string;
}

/** Insert a synthetic staff member. All test identities use example.test addresses. */
export async function makeStaff(
  db: pg.Pool,
  config: Config,
  opts: { email: string; name: string; role: string; password: string; totpSecret?: string }
): Promise<TestStaff> {
  const role = await db.query<{ id: string }>(`SELECT id FROM roles WHERE key = $1`, [opts.role]);
  if (!role.rows[0]) throw new Error(`role ${opts.role} not seeded`);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO staff (full_name, email, role_id, password_hash, totp_secret_enc, totp_enabled)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      opts.name,
      opts.email,
      role.rows[0].id,
      await argon2.hash(opts.password),
      opts.totpSecret ? encryptSecret(opts.totpSecret, config.APP_ENCRYPTION_KEY) : null,
      Boolean(opts.totpSecret),
    ]
  );
  const staff: TestStaff = { id: rows[0]!.id, email: opts.email, password: opts.password };
  if (opts.totpSecret !== undefined) staff.totpSecret = opts.totpSecret;
  return staff;
}

export async function auditRows(db: pg.Pool, action: string, actorLabel?: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    actorLabel
      ? `SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND actor_label = $2`
      : `SELECT count(*)::int AS n FROM audit_log WHERE action = $1`,
    actorLabel ? [action, actorLabel] : [action]
  );
  return rows[0]!.n;
}
