/*
 * THE UNVERIFIED-IMPORT TAG (2026-09-12 night, Brian's ruling 2).
 *
 *   A business named after its contact with no EIN and no entity type is tagged, and the tag
 *   and entity type reach every picker.
 *
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { createRequire } from 'node:module';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

const require = createRequire(import.meta.url);
const { isSelfNamed } = require('../../../packages/db/lib/self-named.js') as { isSelfNamed: (b: string, f: string, l: string) => boolean };

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('unverified');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-dupscan@example.test', 'ceo');
});
after(async () => { await app.close(); });

test('a business named after its contact with no EIN and no entity type is tagged, and the tag and entity type reach the pickers', async () => {
  // The rule, by word: the import's household names match; a real organisation does not.
  assert.equal(isSelfNamed('JUAN LOZA and IVONNE LOZA', 'Juan', 'Loza'), true);
  assert.equal(isSelfNamed('ANGEL M SIDA JR', 'Angel', 'Sida, Jr'), true);
  assert.equal(isSelfNamed('ESTEBAN DELEON', 'Esteban', 'De Leon'), false, 'a run-together surname is not claimed; a person decides');
  assert.equal(isSelfNamed('312 Housing Collective', 'Amy', 'Jewel'), false);
  assert.equal(isSelfNamed('JUAN and IVONNE LOZA', 'Juan', 'Perez'), false, 'the last name has to be there too');
  assert.equal(isSelfNamed('Perez Landscaping', 'Alberto', 'Perez'), false, 'the first name has to be there too');

  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Household', email: 'household-dupscan@example.test' });
  const b = await app.db.query<{ id: string }>(`INSERT INTO businesses (name, source, unverified_import_source) VALUES ('SYNTHETIC HOUSEHOLD and SPOUSE HOUSEHOLD', 'zoho', 'zoho') RETURNING id`);
  await app.db.query(`INSERT INTO business_members (business_id, contact_id, member_role, is_primary) VALUES ($1, $2, 'owner', true)`, [b.rows[0]!.id, c.id]);
  const page = await app.inject({ method: 'GET', url: `/contacts/${c.id}`, headers: auth(brian) });
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().businesses[0].unverified_import_source, 'zoho');
  assert.equal(page.json().businesses[0].entity_type, null);
  const picker = await app.inject({ method: 'GET', url: '/businesses?search=SYNTHETIC%20HOUSEHOLD', headers: auth(brian) });
  assert.equal(picker.statusCode, 200, picker.body);
  assert.deepEqual(picker.json().businesses.map((x: { entity_type: string | null; unverified_import_source: string | null }) => [x.entity_type, x.unverified_import_source]), [[null, 'zoho']]);
});
