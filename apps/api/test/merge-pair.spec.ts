// R92 (Brian, 2026-09-29): THE PAIR DOOR. Two records the duplicate review marked "merge": the CEO
// alone, with a standalone reason; the survivor is the record with the portal user, else the most
// engagements, else the older one; the retired record is kept with a redirect, its rows re-pointed,
// and it leaves search. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
let rene: TestStaff & { token: string };
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const REASON = 'Duplicate review 2026-09-28: the same person entered twice (synthetic).';

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

/** Two synthetic records of one person, sharing a phone (the merge's identity rule). */
async function pair(last: string): Promise<{ a: string; b: string }> {
  const a = await makeContact(app.db, { firstName: 'Synthetic', lastName: last, email: `${last.toLowerCase()}-a@example.test` });
  const b = await makeContact(app.db, { firstName: 'Synthetic', lastName: last, email: `${last.toLowerCase()}-b@example.test` });
  await app.db.query(`UPDATE contacts SET phone = '+13125550199' WHERE id = ANY($1::uuid[])`, [[a.id, b.id]]);
  return { a: a.id, b: b.id };
}

before(async () => {
  config = await createTestConfig('mergepair');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  ceo = await staffWithToken('ceo-mergepair@example.test', 'ceo');
  rene = await staffWithToken('rene-mergepair@example.test', 'comms_billing');
});
after(async () => { await app.close(); });

test('the survivor is the record with the portal user; the retired record redirects, leaves search, and its rows move', async () => {
  const { a, b } = await pair('Pairportal');
  // a holds the work; b holds the sign-in. The sign-in decides.
  await app.db.query(`INSERT INTO engagements (contact_id, service_line, status, title, period_key) VALUES ($1, 'bookkeeping', 'active', 'Books', 'ongoing')`, [a]);
  await app.db.query(`INSERT INTO portal_users (contact_id, email) VALUES ($1, 'pairportal-b@example.test')`, [b]);
  const doc = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, category, filename, minio_bucket, minio_key, uploaded_by_type) VALUES ($1, 'tax_documents', 'synthetic.pdf', 'saos-documents', 'test/pair.pdf', 'staff') RETURNING id`, [a]);

  const refused = await app.inject({ method: 'POST', url: '/contacts/merge-pair', headers: auth(rene), payload: { aId: a, bId: b, reason: REASON } });
  assert.equal(refused.statusCode, 403, 'the CEO alone');

  const res = await app.inject({ method: 'POST', url: '/contacts/merge-pair', headers: auth(ceo), payload: { aId: a, bId: b, reason: REASON } });
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json() as { survivorId: string; retiredId: string; survivorRule: string };
  assert.deepEqual([out.survivorId, out.retiredId, out.survivorRule], [b, a, 'portal_user']);

  // Re-pointed: the work and the document are on the survivor now.
  const eng = await app.db.query<{ contact_id: string }>(`SELECT contact_id FROM engagements WHERE title = 'Books' AND contact_id = ANY($1::uuid[])`, [[a, b]]);
  assert.equal(eng.rows[0]!.contact_id, b);
  const d = await app.db.query<{ contact_id: string }>(`SELECT contact_id FROM documents WHERE id = $1`, [doc.rows[0]!.id]);
  assert.equal(d.rows[0]!.contact_id, b);

  // The retired record is kept, and anything pointing at it is told where the client is now.
  const kept = await app.db.query<{ is_archived: boolean; merged_into_contact_id: string }>(`SELECT is_archived, merged_into_contact_id FROM contacts WHERE id = $1`, [a]);
  assert.deepEqual([kept.rows[0]!.is_archived, kept.rows[0]!.merged_into_contact_id], [true, b]);
  const redirect = await app.inject({ method: 'GET', url: `/contacts/${a}`, headers: auth(ceo) });
  assert.equal(redirect.statusCode, 200, redirect.body);
  assert.deepEqual(redirect.json(), { merged_into: b });

  // It leaves search.
  const search = await app.inject({ method: 'GET', url: '/contacts?search=Pairportal&limit=10', headers: auth(ceo) });
  assert.deepEqual((search.json().contacts as Array<{ id: string }>).map((c) => c.id), [b]);
  const audit = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'contact.merged' AND object_id = $1`, [a]);
  assert.equal(audit.rows.length, 1);
});

test('with no portal user on either side, the most engagements decides; then the older record', async () => {
  const one = await pair('Pairwork');
  await app.db.query(`INSERT INTO engagements (contact_id, service_line, status, title, period_key) VALUES ($1, 'payroll', 'active', 'Payroll', 'ongoing')`, [one.b]);
  const r1 = await app.inject({ method: 'POST', url: '/contacts/merge-pair', headers: auth(ceo), payload: { aId: one.a, bId: one.b, reason: REASON } });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.deepEqual([r1.json().survivorId, r1.json().survivorRule], [one.b, 'engagements']);

  const two = await pair('Pairolder');
  const r2 = await app.inject({ method: 'POST', url: '/contacts/merge-pair', headers: auth(ceo), payload: { aId: two.b, bId: two.a, reason: REASON } });
  assert.equal(r2.statusCode, 200, r2.body);
  assert.deepEqual([r2.json().survivorId, r2.json().survivorRule], [two.a, 'older_record'], 'the record entered first stays');
});
