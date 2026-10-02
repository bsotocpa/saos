// Batch 16 (Brian, 2026-10-02): R117, portal withdrawals. A withdrawal records its kind, chosen by the
// person withdrawing; a withdrawal of the firm's own record (a duplicate, a migration leftover, an import
// error) is hidden from the portal entirely and stays in Ops; the client sees only the withdrawals they
// would recognize. Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
const auth = () => ({ authorization: `Bearer ${ceo.token}` });

before(async () => {
  config = await createTestConfig('withdrawalkind');
  app = buildServer(config);
  await app.ready();
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const s = await makeStaff(app.db, config, { email: 'ceo-wk@example.test', name: 'Synthetic ceo', role: 'ceo', password: 'ceo-password-1234567', totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  ceo = { ...s, token: (await app.inject({ method: 'POST', url: '/auth/login', payload: { email: s.email, password: s.password, totp: code } })).json().token as string };
});
after(async () => { await app.close(); });

async function client(name: string) {
  const email = `${name.toLowerCase()}@example.test`;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: name, email });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const pu = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [c.id, email]);
  const token = randomBytes(32).toString('base64url');
  await app.db.query(`INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [pu.rows[0]!.id, createHash('sha256').update(token).digest('hex')]);
  return { contactId: c.id, cookie: { cookie: `saos_portal_session=${token}` } };
}
const newReturn = async (contactId: string, taxYear: number) =>
  (await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(), payload: { contactId, taxYear, returnType: '1040', clientType: 'individual', reason: 'Synthetic: a return.' } })).json().id as string;
const stageOf = async (te: string) => (await app.db.query<{ stage: string; withdrawal_kind: string | null }>(
  `SELECT stage::text AS stage, withdrawal_kind FROM tax_engagements WHERE id = $1`, [te])).rows[0]!;
const portalReturns = async (cookie: { cookie: string }) =>
  ((await app.inject({ method: 'GET', url: '/portal/engagements', headers: cookie })).json().engagements as Array<{ tax_engagement_id: string | null; withdrawn_kind: string | null }>);

test('R117: a withdrawal without its kind is refused, in words, and nothing moves', async () => {
  const c = await client('Nokindapi');
  const te = await newReturn(c.contactId, 2024);
  const t = await app.inject({ method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(), payload: { toStage: 'withdrawn', note: 'Synthetic: no kind given.' } });
  assert.equal(t.statusCode, 400, t.body);
  assert.equal(t.json().error, 'withdrawal_kind_required');
  assert.match(t.json().message, /firm's own record/);
  assert.notEqual((await stageOf(te)).stage, 'withdrawn', 'the return did not move');

  const eng = (await app.db.query<{ engagement_id: string }>(`SELECT engagement_id FROM tax_engagements WHERE id = $1`, [te])).rows[0]!.engagement_id;
  const close = await app.inject({ method: 'POST', url: `/engagements/${eng}/close`, headers: auth(), payload: { outcome: 'withdrawn', reason: 'Synthetic: no kind given.' } });
  assert.equal(close.statusCode, 400, close.body);
  assert.equal(close.json().error, 'withdrawal_kind_required');
  const status = (await app.db.query<{ status: string }>(`SELECT status::text AS status FROM engagements WHERE id = $1`, [eng])).rows[0]!.status;
  assert.notEqual(status, 'withdrawn', 'the engagement did not close');
});

test("R117: the firm's own record withdrawn is gone from the portal (returns, documents, requests) and stays in Ops", async () => {
  const c = await client('Firmrecordapi');
  const dup = await newReturn(c.contactId, 2023);
  const docOnDup = (await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, category, filename, minio_bucket, minio_key, uploaded_by_type, scan_status, tax_engagement_id)
     VALUES ($1, 'tax_documents', 'synthetic-w2-on-duplicate.pdf', 'synthetic', $2, 'client', 'clean', $3) RETURNING id`,
    [c.contactId, `t/${randomBytes(6).toString('hex')}`, dup])).rows[0]!.id;
  await app.db.query(`INSERT INTO document_requests (contact_id, tax_engagement_id, title_en, status) VALUES ($1, $2, 'Synthetic request on the duplicate', 'open')`, [c.contactId, dup]);

  const before = await portalReturns(c.cookie);
  assert.ok(before.some((r) => r.tax_engagement_id === dup), 'listed for the client while it is live');

  const t = await app.inject({ method: 'POST', url: `/tax-engagements/${dup}/transition`, headers: auth(), payload: { toStage: 'withdrawn', withdrawalKind: 'firm_record', note: 'Synthetic: a duplicate of the real return.' } });
  assert.equal(t.statusCode, 200, t.body);
  assert.deepEqual(await stageOf(dup), { stage: 'withdrawn', withdrawal_kind: 'firm_record' });

  const after = await portalReturns(c.cookie);
  assert.ok(!after.some((r) => r.tax_engagement_id === dup), 'not on the portal at all, not even as a withdrawn line');
  const docs = (await app.inject({ method: 'GET', url: '/portal/documents', headers: c.cookie })).json().documents as Array<{ id: string; return_id: string | null }>;
  assert.equal(docs.find((d) => d.id === docOnDup)?.return_id, null, "the client's file stays, not tied to a return");
  const reqs = (await app.inject({ method: 'GET', url: '/portal/document-requests', headers: c.cookie })).json().requests as Array<{ title_en: string }>;
  assert.ok(!reqs.some((r) => r.title_en === 'Synthetic request on the duplicate'), 'nothing is asked for on it');
  assert.ok(!JSON.stringify((await app.inject({ method: 'GET', url: '/portal/engagements', headers: c.cookie })).json()).includes('duplicate'), 'no staff words either');

  const ops = (await app.inject({ method: 'GET', url: `/tax-engagements?contactId=${c.contactId}`, headers: auth() })).json().taxEngagements as Array<{ id: string; withdrawal_kind: string | null; withdrawn_reason: string | null }>;
  const row = ops.find((r) => r.id === dup);
  assert.ok(row, 'Ops still lists it');
  assert.equal(row!.withdrawal_kind, 'firm_record');
  assert.equal(row!.withdrawn_reason, 'Synthetic: a duplicate of the real return.');
});

test("R117: a withdrawal the client would recognize stays on the portal with the fixed sentence's kind; its engagement's returns carry it", async () => {
  const c = await client('Clientkindapi');
  const te = await newReturn(c.contactId, 2022);
  const eng = (await app.db.query<{ engagement_id: string }>(`SELECT engagement_id FROM tax_engagements WHERE id = $1`, [te])).rows[0]!.engagement_id;
  const close = await app.inject({ method: 'POST', url: `/engagements/${eng}/close`, headers: auth(), payload: { outcome: 'withdrawn', withdrawalKind: 'client', reason: 'Synthetic: the client filed with another preparer.' } });
  assert.equal(close.statusCode, 200, close.body);
  assert.deepEqual(await stageOf(te), { stage: 'withdrawn', withdrawal_kind: 'client' }, 'the cascade records the kind on every unfiled return');
  const row = (await portalReturns(c.cookie)).find((r) => r.tax_engagement_id === te);
  assert.ok(row, 'listed for the client');
  assert.equal(row!.withdrawn_kind, 'closed', 'the fixed sentence, never the staff note');
});

test('R117: the database holds every withdrawn return to a kind, and no live return to one', async () => {
  const c = await client('Checkkindapi');
  const te = await newReturn(c.contactId, 2021);
  await assert.rejects(app.db.query(`UPDATE tax_engagements SET stage = 'withdrawn' WHERE id = $1`, [te]), /withdrawal_kind_with_stage/);
  await assert.rejects(app.db.query(`UPDATE tax_engagements SET withdrawal_kind = 'client' WHERE id = $1`, [te]), /withdrawal_kind_with_stage/);
  await assert.rejects(app.db.query(`UPDATE tax_engagements SET stage = 'withdrawn', withdrawal_kind = 'mistake' WHERE id = $1`, [te]), /withdrawal_kind_valid/);
});
