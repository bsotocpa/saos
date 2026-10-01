// Batch 15 (Brian, 2026-09-30): R110, the portal Documents list by return — each file names the return
// it belongs to (filed against it, or answering its checklist), a superseded file never reaches the
// client; R108, a withdrawn return is listed for Ops with its day and recorded reason, and for the client
// with its day and the kind of reason (never the staff's words). Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { acceptQuote, createQuote, sendQuote } from '../src/modules/pricing/quotes.ts';
import { countDocumentAs } from '../src/modules/documents/counts-as.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
const auth = () => ({ authorization: `Bearer ${ceo.token}` });
const actor = () => ({ id: ceo.id, email: ceo.email, fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

before(async () => {
  config = await createTestConfig('batch15');
  app = buildServer(config);
  await app.ready();
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const s = await makeStaff(app.db, config, { email: 'ceo-b15@example.test', name: 'Synthetic ceo', role: 'ceo', password: 'ceo-password-1234567', totpSecret: secret });
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
const doc = async (contactId: string, name: string, te: string | null) => (await app.db.query<{ id: string }>(
  `INSERT INTO documents (contact_id, category, filename, minio_bucket, minio_key, uploaded_by_type, scan_status, tax_engagement_id)
   VALUES ($1, 'tax_documents', $2, 'synthetic', $3, 'client', 'clean', $4) RETURNING id`,
  [contactId, name, `t/${randomBytes(6).toString('hex')}`, te])).rows[0]!.id;

test('R110: each file names its return — filed against it or answering its checklist — and a superseded file is not the client\'s', async () => {
  const c = await client('Byreturnapi');
  const biz = await app.inject({ method: 'POST', url: `/contacts/${c.contactId}/businesses`, headers: auth(), payload: { name: 'Synthetic Byreturn Api LLC', entityType: 's_corp', state: 'IL' } });
  const q = await createQuote(app, { contactId: c.contactId, lines: [{ itemCode: 'IND_BASE_SINGLE' }, { itemCode: 'IND_SCH_B_D' }] }, actor());
  const sent = await sendQuote(app, q.id, actor());
  await acceptQuote(app, sent.url.split('/').pop()!, {});
  const te1040 = (await app.db.query<{ id: string; tax_year: number }>(`SELECT te.id, te.tax_year FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE e.contact_id = $1`, [c.contactId])).rows[0]!;
  const te1120 = (await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(), payload: { contactId: c.contactId, businessId: biz.json().id, taxYear: te1040.tax_year, returnType: '1120s', clientType: 'business', reason: 'Synthetic: the business return.' } })).json().id as string;
  const on1040 = await doc(c.contactId, 'on-1040.pdf', te1040.id);
  const on1120 = await doc(c.contactId, 'on-1120s.pdf', te1120);
  const answering = await doc(c.contactId, 'answers-an-item.pdf', null);
  const loose = await doc(c.contactId, 'loose.pdf', null);
  const old = await doc(c.contactId, 'superseded.pdf', te1040.id);
  await app.db.query(`UPDATE documents SET superseded_by = $2, superseded_at = now() WHERE id = $1`, [old, on1040]);
  const item = (await app.db.query<{ id: string }>(`SELECT i.id FROM document_request_items i JOIN document_requests dr ON dr.id = i.request_id WHERE dr.tax_engagement_id = $1 AND dr.source = 'checklist' ORDER BY i.seq LIMIT 1`, [te1040.id])).rows[0]!;
  await countDocumentAs(app, { type: 'staff', id: ceo.id, label: 'Synthetic CEO' }, { documentId: answering, itemId: item.id });

  const res = await app.inject({ method: 'GET', url: '/portal/documents', headers: c.cookie });
  assert.equal(res.statusCode, 200, res.body);
  const docs = res.json().documents as Array<{ id: string; return_id: string | null; return_year: number | null; return_type: string | null; return_business: string | null }>;
  const by = (id: string) => docs.find((d) => d.id === id);
  assert.equal(by(old), undefined, 'the superseded file is not listed');
  assert.deepEqual([by(on1040)?.return_id, by(on1040)?.return_type, by(on1040)?.return_business], [te1040.id, '1040', null]);
  assert.deepEqual([by(answering)?.return_id, by(answering)?.return_year], [te1040.id, te1040.tax_year], 'a file answering a checklist item belongs to that return');
  assert.deepEqual([by(on1120)?.return_id, by(on1120)?.return_type, by(on1120)?.return_business], [te1120, '1120s', 'Synthetic Byreturn Api LLC']);
  assert.equal(by(loose)?.return_id, null, 'a file tied to no return');
  const staff = await app.inject({ method: 'GET', url: `/documents?contactId=${c.contactId}`, headers: auth() });
  assert.ok(JSON.stringify(staff.json()).includes(old), 'the superseded file stays in Ops');
});

test('R108: a withdrawn return carries its day and reason for Ops, and its day and the kind of reason for the client', async () => {
  const c = await client('Withdrawnapi');
  const te = (await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(), payload: { contactId: c.contactId, taxYear: 2024, returnType: '1040', clientType: 'individual', reason: 'Synthetic: a prior year.' } })).json().id as string;
  const t = await app.inject({ method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(), payload: { toStage: 'withdrawn', note: 'Synthetic staff note: filed elsewhere.' } });
  assert.equal(t.statusCode, 200, t.body);

  const ops = await app.inject({ method: 'GET', url: `/tax-engagements?contactId=${c.contactId}`, headers: auth() });
  const row = (ops.json().taxEngagements as Array<{ id: string; withdrawn_on: string; withdrawn_reason: string }>).find((r) => r.id === te)!;
  assert.equal(row.withdrawn_on, todayChicago(), 'withdrawn today, in Chicago');
  assert.equal(row.withdrawn_reason, 'Synthetic staff note: filed elsewhere.');

  const portal = await app.inject({ method: 'GET', url: '/portal/engagements', headers: c.cookie });
  assert.equal(portal.statusCode, 200, portal.body);
  const prow = (portal.json().engagements as Array<{ tax_engagement_id: string; withdrawn_on: string; withdrawn_kind: string; deadline: string | null }>).find((r) => r.tax_engagement_id === te);
  assert.ok(prow, 'the withdrawn return is listed for the client');
  assert.equal(prow!.withdrawn_on, todayChicago());
  assert.equal(prow!.withdrawn_kind, 'closed');
  assert.equal(prow!.deadline, null, 'no deadline on a withdrawn return');
  assert.ok(!JSON.stringify(portal.json()).includes('Synthetic staff note'), 'the staff\'s words never reach the client');
});
