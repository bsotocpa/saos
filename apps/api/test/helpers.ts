import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
/*
 * ONE CHECKOUT, ITS OWN TEST DATABASES (2026-09-27). The receipt runs from a worktree
 * (C:\Users\brian\saos-receipt) while specs run in the main checkout, against the same Postgres. A
 * spec recreates its database with DROP ... WITH (FORCE), so the same spec in the other checkout lost
 * its database mid-run. The name now carries a short tag of the checkout's own path.
 */
/** The tag of a checkout root, as its test databases carry it (the root with a trailing separator, lower case). */
export function checkoutTag(root: string): string {
  const withSep = resolve(root) + sep;
  return createHash('sha1').update(withSep.toLowerCase()).digest('hex').slice(0, 6);
}
const CHECKOUT_TAG = checkoutTag(fileURLToPath(new URL('../../..', import.meta.url)));

/** The test database a spec's createTestConfig(suffix) creates, in this checkout. */
export function testDatabaseName(dbSuffix: string): string {
  return `saos_api_test_${CHECKOUT_TAG}_${dbSuffix}`;
}

/*
 * ONE MIGRATED TEMPLATE, CLONED PER SPEC (Brian, 2026-09-29, R95). Every spec used to run all the
 * migrations and seeds into its own fresh database, ~145 times a suite, and the files that churn
 * dirtied were what each forced checkpoint then had to sync. Now the migrations and seeds run once,
 * into a template named for the hash of every migration and seed file (so any change to either
 * builds a new one), and each spec's database is CREATE DATABASE ... TEMPLATE of it. The build runs
 * under an advisory lock, so parallel spec processes wait for one builder instead of racing.
 */
const DB_PACKAGE = fileURLToPath(new URL('../../../packages/db', import.meta.url));

/** The hash of every migration and seed file, and the list that orders the seeds. */
export function schemaHash(): string {
  const h = createHash('sha1');
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else { h.update(p.slice(DB_PACKAGE.length).replaceAll('\\', '/')); h.update(readFileSync(p)); }
    }
  };
  walk(join(DB_PACKAGE, 'migrations'));
  walk(join(DB_PACKAGE, 'seeds'));
  h.update(readFileSync(join(DB_PACKAGE, 'index.mjs')));
  return h.digest('hex').slice(0, 10);
}

/** This checkout's template for the migrations and seeds as they stand. */
export function templateDatabaseName(): string {
  return `saos_api_test_${CHECKOUT_TAG}_tpl_${schemaHash()}`;
}

function databaseUrl(name: string): string {
  const url = new URL(loadConfig({ NODE_ENV: 'test' }).DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

export async function adminClient(): Promise<pg.Client> {
  const admin = new pg.Client({ connectionString: databaseUrl('postgres') });
  await admin.connect();
  return admin;
}

/** Drop a database, a template included (Postgres refuses to drop one still marked as a template). */
export async function dropDatabase(admin: pg.Client, name: string): Promise<void> {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`refusing to drop '${name}'`);
  const found = await admin.query(`SELECT datistemplate FROM pg_database WHERE datname = $1`, [name]);
  if (found.rows.length === 0) return;
  if (found.rows[0].datistemplate) await admin.query(`ALTER DATABASE ${name} IS_TEMPLATE false`);
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

/** Build this checkout's template if the migrations or seeds changed since the last one; return its name. */
export async function ensureTestTemplate(): Promise<string> {
  const tpl = templateDatabaseName();
  const admin = await adminClient();
  try {
    await admin.query('SELECT pg_advisory_lock(hashtext($1))', [`saos_api_test_tpl_${CHECKOUT_TAG}`]);
    const have = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [tpl]);
    if (have.rows.length > 0) return tpl;
    // A template for migrations or seeds that no longer stand goes first.
    const stale = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname ~ $1 AND datname <> $2`,
      [`^saos_api_test_${CHECKOUT_TAG}_tpl_`, tpl]
    );
    for (const r of stale.rows) await dropDatabase(admin, r.datname);
    const build = `${tpl}_build`;
    await dropDatabase(admin, build);
    await admin.query(`CREATE DATABASE ${build}`);
    await migrate(databaseUrl(build), 'up');
    const seeder = new pg.Client({ connectionString: databaseUrl(build) });
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
    // Complete before it has its name: a template that exists is a template that is whole.
    await admin.query(`ALTER DATABASE ${build} RENAME TO ${tpl}`);
    await admin.query(`ALTER DATABASE ${tpl} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`);
    return tpl;
  } finally {
    await admin.query('SELECT pg_advisory_unlock_all()').catch(() => undefined);
    await admin.end();
  }
}

export async function createTestConfig(dbSuffix: string): Promise<Config> {
  if (!/^[a-z0-9_]+$/.test(dbSuffix)) throw new Error('dbSuffix must be [a-z0-9_]+');
  const testDb = testDatabaseName(dbSuffix);
  if (testDb.length > 63) throw new Error(`test database name too long for Postgres: ${testDb}`);
  const tpl = await ensureTestTemplate();

  // Recreate the test database from the template, via the maintenance DB on the same server.
  const admin = await adminClient();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${testDb} TEMPLATE ${tpl}`);
  } finally {
    await admin.end();
  }
  return loadConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl(testDb) });
}

export interface TestStaff {
  id: string;
  email: string;
  /** Item 11: actors are named, never emailed — the helper carries the name the row was made with. */
  fullName: string;
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
    `INSERT INTO staff (legal_name, display_name, email, role_id, password_hash, totp_secret_enc, totp_enabled)
     VALUES ($1, $1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      opts.name,
      opts.email,
      role.rows[0].id,
      await argon2.hash(opts.password),
      opts.totpSecret ? encryptSecret(opts.totpSecret, config.APP_ENCRYPTION_KEY) : null,
      Boolean(opts.totpSecret),
    ]
  );
  const staff: TestStaff = { id: rows[0]!.id, email: opts.email, fullName: opts.name, password: opts.password };
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

/**
 * The business a fixture quote is for (2026-09-12, Brian): a business line on a quote names its
 * business, so a synthetic contact quoting one gets a synthetic business, once, primary if none.
 */
export async function businessFor(db: Db, contactId: string): Promise<string> {
  const have = await db.query<{ business_id: string }>(
    `SELECT m.business_id FROM business_members m JOIN businesses b ON b.id = m.business_id
      WHERE m.contact_id = $1 AND NOT b.is_archived ORDER BY m.is_primary DESC LIMIT 1`, [contactId]);
  if (have.rows[0]) return have.rows[0].business_id;
  const biz = await db.query<{ id: string }>(
    `INSERT INTO businesses (name, entity_type, state) VALUES ('Synthetic Fixture LLC ' || left($1::text, 8), 'llc', 'IL') RETURNING id`, [contactId]);
  await db.query(
    `INSERT INTO business_members (business_id, contact_id, member_role, is_primary)
     VALUES ($1, $2, 'owner', NOT EXISTS (SELECT 1 FROM business_members WHERE contact_id = $2 AND is_primary))`, [biz.rows[0]!.id, contactId]);
  return biz.rows[0]!.id;
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

/**
 * THE SIGNED 8879 ON FILE (2026-09-12). A return cannot be authorized without the uploaded scan
 * — the database refuses a timestamp with no document. Fixtures that need a return past that
 * gate put a synthetic Signed Authorization on file through the real recorder.
 */
export async function signed8879OnFile(
  app: { db: Db },
  taxEngagementId: string,
  staffId: string,
  signedOn = '2026-09-01'
): Promise<string> {
  const te = await app.db.query<{ contact_id: string }>(
    `SELECT e.contact_id FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE te.id = $1`, [taxEngagementId]);
  const doc = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, tax_engagement_id, category, filename, minio_bucket, minio_key, uploaded_by_type)
     VALUES ($1, $2, 'signed_authorizations', 'synthetic-signed-8879.pdf', 'saos-signed-docs', 'test/' || gen_random_uuid()::text || '.pdf', 'staff')
     RETURNING id`,
    [te.rows[0]!.contact_id, taxEngagementId]
  );
  const { recordSigned8879 } = await import('../src/modules/tax/signed-8879.ts');
  await recordSigned8879(app as never, { staffId, label: 'Synthetic Preparer' }, {
    taxEngagementId, documentId: doc.rows[0]!.id, signedOn, preparerPtinHolderId: staffId,
  });
  return doc.rows[0]!.id;
}

/**
 * THE SIGNED ENGAGEMENT LETTER ON FILE (2026-09-20). The bare staff route that stamped gate 1 with
 * now() and nothing behind it is retired: the letter is either signed in the portal (which stamps
 * every return it covers) or uploaded as a scan against the return. Fixtures that need a return
 * past gate 1 go through the real recorder, which is what production does.
 */
export async function engagementLetterOnFile(
  app: { db: Db },
  taxEngagementId: string,
  staffId: string,
  signedOn = '2026-09-01'
): Promise<string> {
  const te = await app.db.query<{ contact_id: string }>(
    `SELECT e.contact_id FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE te.id = $1`, [taxEngagementId]);
  const doc = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, tax_engagement_id, category, filename, minio_bucket, minio_key, uploaded_by_type)
     VALUES ($1, $2, 'signed_authorizations', 'synthetic-signed-engagement-letter.pdf', 'saos-signed-docs', 'test/' || gen_random_uuid()::text || '.pdf', 'staff')
     RETURNING id`,
    [te.rows[0]!.contact_id, taxEngagementId]
  );
  const { recordSignedEngagementLetter } = await import('../src/modules/tax/signed-8879.ts');
  await recordSignedEngagementLetter(app as never, { staffId, label: 'Synthetic Preparer' }, {
    taxEngagementId, documentId: doc.rows[0]!.id, signedOn,
  });
  return doc.rows[0]!.id;
}
