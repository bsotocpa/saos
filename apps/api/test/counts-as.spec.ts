// R96 (Brian, 2026-09-29): "COUNTS AS". A document on file before its return's checklist existed, or
// under a general category, is matched to a checklist item from Ops (documents.write) or by the client
// in the portal: the item reads received with that document, one audit row names who matched it, and
// the refusals hold (someone else's document, a quarantined file, an item already received, a closed
// return, a request that is not a checklist). Synthetic data only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { acceptQuote, createQuote, sendQuote } from '../src/modules/pricing/quotes.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
let va: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const actor = () => ({ id: ceo.id, email: ceo.email, fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

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

/** A return from an accepted quote (its checklist opened), and its pending checklist items. */
async function returnWithChecklist(contactId: string): Promise<{ te: string; items: Array<{ id: string; label_en: string }> }> {
  const q = await createQuote(app, { contactId, lines: [{ itemCode: 'IND_BASE_SINGLE' }, { itemCode: 'IND_SCH_B_D' }] }, actor());
  const sent = await sendQuote(app, q.id, actor());
  await acceptQuote(app, sent.url.split('/').pop()!, {});
  const te = (await app.db.query<{ id: string }>(`SELECT te.id FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE e.contact_id = $1`, [contactId])).rows[0]!.id;
  const items = (await app.db.query<{ id: string; label_en: string }>(
    `SELECT i.id, i.label_en FROM document_request_items i JOIN document_requests dr ON dr.id = i.request_id
      WHERE dr.tax_engagement_id = $1 AND dr.source = 'checklist' ORDER BY i.seq`, [te])).rows;
  assert.ok(items.length >= 2, 'the checklist has items');
  return { te, items };
}

/** A document already on file, uploaded under a general category (synthetic row, no bytes). */
async function docOnFile(contactId: string, opts: { scan?: string; category?: string } = {}): Promise<string> {
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, category, filename, minio_bucket, minio_key, uploaded_by_type, scan_status)
     VALUES ($1, $2::document_category, 'synthetic-upload.pdf', 'synthetic', $3, 'client', $4::document_scan_status) RETURNING id`,
    [contactId, opts.category ?? 'tax_documents', `synthetic/${randomBytes(6).toString('hex')}`, opts.scan ?? 'clean']
  );
  return rows[0]!.id;
}

before(async () => {
  config = await createTestConfig('counts_as');
  app = buildServer(config);
  await app.ready();
  ceo = await staffWithToken('ceo-countsas@example.test', 'ceo');
  va = await staffWithToken('va-countsas@example.test', 'va_entity');
});

after(async () => {
  await app.close();
});

test('Ops: a document on file counts as a pending checklist item; the item is received with it, audited; the list says so', async () => {
  const c = await client('CountsOps');
  const { items } = await returnWithChecklist(c.contactId);
  const doc = await docOnFile(c.contactId);
  const open = await app.inject({ method: 'GET', url: `/documents/checklist-items?contactId=${c.contactId}`, headers: auth(ceo) });
  assert.equal(open.statusCode, 200, open.body);
  assert.equal(open.json().items.length, items.length, 'every pending item is offered');

  const res = await app.inject({ method: 'POST', url: `/documents/${doc}/counts-as`, headers: auth(ceo), payload: { itemId: items[0]!.id } });
  assert.equal(res.statusCode, 200, res.body);
  const item = await app.db.query<{ status: string; document_id: string }>(`SELECT status::text, document_id FROM document_request_items WHERE id = $1`, [items[0]!.id]);
  assert.deepEqual(item.rows[0], { status: 'received', document_id: doc });
  const audit = await app.db.query<{ actor_type: string; details: { item_id: string } }>(`SELECT actor_type::text, details FROM audit_log WHERE action = 'document.counted_as_checklist_item' AND object_id = $1`, [doc]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.details.item_id, items[0]!.id);

  const list = await app.inject({ method: 'GET', url: `/documents?contactId=${c.contactId}`, headers: auth(ceo) });
  const row = (list.json().documents as Array<{ id: string; counts_as: Array<{ itemId: string }> }>).find((d) => d.id === doc)!;
  assert.deepEqual(row.counts_as.map((x) => x.itemId), [items[0]!.id]);

  // An item already received is refused; so is a role whose wall does not reach the category.
  const again = await app.inject({ method: 'POST', url: `/documents/${await docOnFile(c.contactId)}/counts-as`, headers: auth(ceo), payload: { itemId: items[0]!.id } });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'item_already_received');
  const walled = await app.inject({ method: 'POST', url: `/documents/${doc}/counts-as`, headers: auth(va), payload: { itemId: items[1]!.id } });
  assert.ok(walled.statusCode === 403, `the entity VA is refused a tax document: ${walled.statusCode}`);
});

test('the refusals: a quarantined file, someone else\'s item, a closed return', async () => {
  const a = await client('CountsA');
  const b = await client('CountsB');
  const { items: aItems } = await returnWithChecklist(a.contactId);
  const bInfo = await returnWithChecklist(b.contactId);
  const infected = await docOnFile(a.contactId, { scan: 'infected' });
  const r1 = await app.inject({ method: 'POST', url: `/documents/${infected}/counts-as`, headers: auth(ceo), payload: { itemId: aItems[0]!.id } });
  assert.equal(r1.json().error, 'document_quarantined');
  const aDoc = await docOnFile(a.contactId);
  const r2 = await app.inject({ method: 'POST', url: `/documents/${aDoc}/counts-as`, headers: auth(ceo), payload: { itemId: bInfo.items[0]!.id } });
  assert.equal(r2.statusCode, 404, 'another client\'s item');
  await app.db.query(`UPDATE tax_engagements SET stage = 'withdrawn' WHERE id = $1`, [bInfo.te]);
  const bDoc = await docOnFile(b.contactId);
  const r3 = await app.inject({ method: 'POST', url: `/documents/${bDoc}/counts-as`, headers: auth(ceo), payload: { itemId: bInfo.items[1]!.id } });
  assert.equal(r3.json().error, 'return_closed');
});

test('portal: the client picks the item a file already sent is for; someone else\'s document is not found; the row says what it counts as', async () => {
  const c = await client('CountsPortal');
  const other = await client('CountsOther');
  const { items } = await returnWithChecklist(c.contactId);
  const doc = await docOnFile(c.contactId);
  const res = await app.inject({ method: 'POST', url: `/portal/documents/${doc}/counts-as`, headers: c.cookie, payload: { itemId: items[1]!.id } });
  assert.equal(res.statusCode, 200, res.body);
  const audit = await app.db.query<{ actor_type: string }>(`SELECT actor_type::text FROM audit_log WHERE action = 'document.counted_as_checklist_item' AND object_id = $1`, [doc]);
  assert.equal(audit.rows[0]!.actor_type, 'client', 'audited as the client');
  const list = await app.inject({ method: 'GET', url: '/portal/documents', headers: c.cookie });
  const row = (list.json().documents as Array<{ id: string; counts_as: Array<{ itemId: string }> }>).find((d) => d.id === doc)!;
  assert.deepEqual(row.counts_as.map((x) => x.itemId), [items[1]!.id]);
  const theirs = await docOnFile(other.contactId);
  const nope = await app.inject({ method: 'POST', url: `/portal/documents/${theirs}/counts-as`, headers: c.cookie, payload: { itemId: items[0]!.id } });
  assert.equal(nope.statusCode, 404, 'another client\'s document reads as not found');
});
