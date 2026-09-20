/*
 * TWO NARROW GRANTS (Brian, 2026-09-19 evening, R3 and R4). Both are seeded from
 * packages/db/seeds/data/roles.mjs, so production picks them up on the next deploy's seed run.
 *
 *   efile.manage      — the tax preparer owns the ATX acknowledgment screen: upload, review, release.
 *                       The six /efile-acks routes ask for this and nothing else.
 *   businesses.write  — the entity VA records the business she files for. POST
 *                       /contacts/:id/businesses accepts contacts.write OR businesses.write, so the
 *                       front desk keeps the door it had and she gets one that opens nothing else.
 *
 * A grant is proven twice here: the row the seed wrote, and the route's own answer. Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let ana: Signed;
let laura: Signed;
let marian: Signed;
let rene: Signed;
let contactId: string;

interface Signed extends TestStaff { token: string }
const auth = (t: Signed) => ({ authorization: `Bearer ${t.token}` });

async function signedIn(email: string, role: string): Promise<Signed> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const totp = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

/** What the seed actually wrote for a role — the deploy path, not the file. */
async function granted(roleKey: string): Promise<string[]> {
  const { rows } = await app.db.query<{ permission: string }>(
    `SELECT p.permission FROM role_permissions p JOIN roles r ON r.id = p.role_id WHERE r.key = $1 ORDER BY p.permission`,
    [roleKey]
  );
  return rows.map((r) => r.permission);
}

before(async () => {
  config = await createTestConfig('roles_grants');
  app = buildServer(config);
  await app.ready();
  ana = await signedIn('ana-grants@example.test', 'tax_preparer');
  laura = await signedIn('laura-grants@example.test', 'va_entity');
  marian = await signedIn('marian-grants@example.test', 'bookkeeper');
  rene = await signedIn('rene-grants@example.test', 'comms_billing');
  contactId = (await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Grantee', email: 'grantee@example.test' })).id;
});
after(async () => { await app.close(); });

test('the tax preparer is seeded efile.manage and the e-file acks list answers her', async () => {
  assert.ok((await granted('tax_preparer')).includes('efile.manage'), 'the seed grants it to the preparer');
  const res = await app.inject({ method: 'GET', url: '/efile-acks', headers: auth(ana) });
  assert.equal(res.statusCode, 200, res.body);
  assert.ok(Array.isArray(res.json().reports), 'and she reads the list');
});

test('a role without efile.manage is refused the e-file acks list, and told which permission', async () => {
  assert.ok(!(await granted('bookkeeper')).includes('efile.manage'), 'the bookkeeper is not granted it');
  const res = await app.inject({ method: 'GET', url: '/efile-acks', headers: auth(marian) });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(res.json().permission, 'efile.manage');
});

test('the entity VA adds a business through businesses.write; a role holding neither door is refused', async () => {
  assert.ok((await granted('va_entity')).includes('businesses.write'), 'the seed grants it to the entity VA');
  assert.ok(!(await granted('va_entity')).includes('contacts.write'), 'and it is the narrow grant, not contacts.write');

  const mine = await app.inject({ method: 'POST', url: `/contacts/${contactId}/businesses`, headers: auth(laura), payload: { name: 'Synthetic Entity Filing LLC', entityType: 'llc', state: 'IL' } });
  assert.equal(mine.statusCode, 201, mine.body);

  const refused = await app.inject({ method: 'POST', url: `/contacts/${contactId}/businesses`, headers: auth(marian), payload: { name: 'Synthetic Refused LLC', entityType: 'llc', state: 'IL' } });
  assert.equal(refused.statusCode, 403, refused.body);
  const rows = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM businesses WHERE name = 'Synthetic Refused LLC'`);
  assert.equal(rows.rows[0]!.n, 0, 'nothing was written by the refused call');
});

test('contacts.write still opens the same door: the front desk is unchanged', async () => {
  const res = await app.inject({ method: 'POST', url: `/contacts/${contactId}/businesses`, headers: auth(rene), payload: { name: 'Synthetic Front Desk LLC', entityType: 'llc', state: 'IL' } });
  assert.equal(res.statusCode, 201, res.body);
});
