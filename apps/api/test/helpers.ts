// Test infrastructure: each suite run gets a FRESH database (dropped and
// recreated, migrated, seeded via @saos/db) so tests never touch dev data and
// audit-log immutability can't pollute anything that matters.

import argon2 from 'argon2';
import pg from 'pg';
import { migrate, seedAll } from '@saos/db';
import { loadConfig, type Config } from '../src/config.ts';
import type { Db } from '../src/db.ts';
import { encryptSecret } from '../src/crypto.ts';

/**
 * Each spec FILE gets its own database (node --test runs files in parallel
 * processes — a shared name races on DROP/CREATE). Suffixes are a fixed set,
 * so reruns recycle the same databases instead of accumulating orphans.
 */
export async function createTestConfig(dbSuffix: string): Promise<Config> {
  if (!/^[a-z0-9_]+$/.test(dbSuffix)) throw new Error('dbSuffix must be [a-z0-9_]+');
  const testDb = `saos_api_test_${dbSuffix}`;
  const base = loadConfig({ NODE_ENV: 'test' });
  const url = new URL(base.DATABASE_URL);

  // Recreate the test database via the maintenance DB on the same server.
  const adminUrl = new URL(base.DATABASE_URL);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${testDb}`);
  } finally {
    await admin.end();
  }

  url.pathname = `/${testDb}`;
  const testUrl = url.toString();

  await migrate(testUrl, 'up');
  const seeder = new pg.Client({ connectionString: testUrl });
  await seeder.connect();
  try {
    await seeder.query('BEGIN');
    await seedAll(seeder);
    // Client-acting automations ship DISABLED (Brian arms them in prod as
    // clients arrive). Tests ARM them all so behaviour is exercised; the
    // gate itself is proven by tests that explicitly disarm one and assert
    // the suppression (see automations.spec.ts).
    await seeder.query(`UPDATE automations SET enabled = true`);
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
  db: Db,
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

/** Insert a synthetic contact (no real client data in tests — CLAUDE.md). */
export async function makeContact(
  db: Db,
  opts: { firstName: string; lastName: string; email: string; language?: 'en' | 'es' }
): Promise<{ id: string; email: string }> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, language, soto_status)
     VALUES ($1, $2, $3, $4, 'lead') RETURNING id`,
    [opts.firstName, opts.lastName, opts.email, opts.language ?? 'en']
  );
  return { id: rows[0]!.id, email: opts.email };
}

/** Build a multipart/form-data payload for fastify.inject (fields + one file). */
export function multipartBody(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; data: Buffer }
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----saosTestBoundary4';
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`
    )
  );
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export async function auditRows(db: Db, action: string, actorLabel?: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    actorLabel
      ? `SELECT count(*)::int AS n FROM audit_log WHERE action = $1 AND actor_label = $2`
      : `SELECT count(*)::int AS n FROM audit_log WHERE action = $1`,
    actorLabel ? [action, actorLabel] : [action]
  );
  return rows[0]!.n;
}
