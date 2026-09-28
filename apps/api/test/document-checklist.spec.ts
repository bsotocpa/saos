// R83 (Brian, 2026-09-27): THE DOCUMENT CHECKLIST FROM THE QUOTED LINES.
//
// Acceptance of a tax quote opens one checklist request for the return from its lines, against the
// seeded, editable document_checklist_items (Admin -> Document checklist), with no email. The Ops
// returns list carries the received / missing counts; the portal reads the list with its order and
// status. "Request documents" (the transition to documents_requested) emails the missing items
// through document_checklist_request, seeded off: while off the send is held and counted. The
// recurring chase leaves a checklist alone until "Request documents" was pressed. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createQuote, sendQuote, acceptQuote } from '../src/modules/pricing/quotes.ts';
import { openChecklistRequest, formNumber } from '../src/modules/documents/checklist.ts';
import { runDocumentChaseJob } from '../src/modules/documents/service.ts';
// @ts-expect-error — the seed is plain JavaScript data under packages/db, where the checklist lives.
import { CHECKLIST } from '../../../packages/db/seeds/data/document_checklist.mjs';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
let preparer: TestStaff & { token: string };
const mail: MailMessage[] = [];
const recordingMailer: Mailer = { transport: 'console', async send(m) { mail.push(m); return { id: `rec-${mail.length}` }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}
const actor = () => ({ id: ceo.id, email: ceo.email, fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

/** A client with a portal session (the cookie the portal sends). */
async function client(name: string, language: 'en' | 'es' = 'en') {
  const email = `${name.toLowerCase()}@example.test`;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: name, email, language });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const pu = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [c.id, email]);
  const token = randomBytes(32).toString('base64url');
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [pu.rows[0]!.id, createHash('sha256').update(token).digest('hex')]
  );
  return { contactId: c.id, email, cookie: { cookie: `saos_portal_session=${token}` } };
}

/** Quote these lines to the client, send, accept; the return the acceptance opened. */
async function accepted(contactId: string, itemCodes: string[]): Promise<{ te: string; year: number }> {
  const q = await createQuote(app, { contactId, lines: itemCodes.map((itemCode) => ({ itemCode })) }, actor());
  const sent = await sendQuote(app, q.id, actor());
  await acceptQuote(app, sent.url.split('/').pop()!, {});
  const { rows } = await app.db.query<{ id: string; tax_year: number }>(
    `SELECT te.id, te.tax_year FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
      WHERE e.contact_id = $1 ORDER BY te.created_at DESC LIMIT 1`,
    [contactId]
  );
  assert.ok(rows[0], 'the acceptance opened a return');
  return { te: rows[0]!.id, year: rows[0]!.tax_year };
}

const k1Rows = (rows: Array<{ doc_key: string; label_en: string }>) => rows.filter((r) => r.doc_key.startsWith('k1'));

async function items(te: string): Promise<Array<{ id: string; doc_key: string; label_en: string; status: string }>> {
  const { rows } = await app.db.query<{ id: string; doc_key: string; label_en: string; status: string }>(
    `SELECT i.id, i.checklist_doc_key AS doc_key, i.label_en, i.status::text AS status
       FROM document_requests dr JOIN document_request_items i ON i.request_id = dr.id
      WHERE dr.tax_engagement_id = $1 AND dr.source = 'checklist' ORDER BY i.seq`,
    [te]
  );
  return rows;
}

const setAutomation = (on: boolean) => app.db.query(`UPDATE automations SET enabled = $1 WHERE key = 'document_checklist_request'`, [on]);

/** A return at Scheduled with its letter signed: the one step before "Request documents". */
async function atScheduled(te: string) {
  await app.db.query(`UPDATE tax_engagements SET stage = 'scheduled', engagement_letter_signed_at = now() WHERE id = $1`, [te]);
}

before(async () => {
  config = await createTestConfig('doccheck');
  app = buildServer(config, { mailer: recordingMailer });
  await app.ready();
  ceo = await staffWithToken('ceo-doccheck@example.test', 'ceo');
  preparer = await staffWithToken('prep-doccheck@example.test', 'tax_preparer');
});

after(async () => {
  await app.close();
});

test('the seed: every item names a price-book item, doc keys are unique per item, and every row carries both languages', async () => {
  const { rows } = await app.db.query<{ item_code: string; n: number }>(
    `SELECT d.item_code, count(*)::int AS n FROM document_checklist_items d GROUP BY d.item_code`
  );
  assert.equal(rows.length, CHECKLIST.length, 'one group per seeded item');
  for (const [code, docs] of CHECKLIST as Array<[string, Array<{ key: string; en: string; es: string }>]>) {
    const known = await app.db.query(`SELECT 1 FROM price_book_items WHERE item_code = $1 LIMIT 1`, [code]);
    assert.equal(known.rows.length, 1, `${code} is a price-book item`);
    assert.equal(new Set(docs.map((d: { key: string }) => d.key)).size, docs.length, `${code}: doc keys unique`);
    for (const d of docs) assert.ok(d.en.trim() && d.es.trim(), `${code}/${d.key}: English and Spanish`);
  }
  assert.equal(formNumber('1120s'), '1120-S');
  assert.equal(formNumber('990ez'), '990-EZ');
  assert.equal(formNumber('1040'), '1040');
  assert.equal(formNumber('w7_itin'), 'W-7');
});

test('acceptance opens the return\'s checklist from its lines, in the book\'s order of the lines, and emails nothing', async () => {
  const c = await client('Accepts');
  const before = mail.length;
  const { te } = await accepted(c.contactId, ['IND_BASE_MFJ', 'IND_SCH_B_D', 'IND_SCH_C']);
  const got = await items(te);
  assert.deepEqual(got.map((i) => i.doc_key), [
    // The base return's four, then Schedule C's two, then Schedule B/D's: the order the lines stand in the book.
    'photo_id', 'prior_year_return', 'w2', 'forms_1099', 'business_income_records', 'business_expense_records', 'forms_1099_int_div_b',
  ]);
  assert.ok(got.every((i) => i.status === 'pending'));
  assert.equal(mail.filter((m, i) => i >= before && m.to === c.email && /Documents for your/.test(m.subject)).length, 0, 'no checklist email at acceptance');
  const audit = await app.db.query(`SELECT details FROM audit_log WHERE action = 'document_request.checklist_opened' AND object_id = $1`, [te]);
  assert.equal(audit.rows.length, 1);
  // Opening it twice for one return opens nothing.
  const again = await openChecklistRequest(app, {
    taxEngagementId: te, engagementId: '00000000-0000-0000-0000-000000000000', contactId: c.contactId,
    itemCodes: ['IND_BASE_MFJ'], taxYear: 2025, returnType: '1040',
  });
  assert.equal(again, null, 'one checklist per return');
});

test('two lines asking for the same document ask once', async () => {
  const c = await client('Dedupe');
  const { te } = await accepted(c.contactId, ['IND_BASE_SINGLE']);
  const eng = await app.db.query<{ engagement_id: string }>(`SELECT engagement_id FROM tax_engagements WHERE id = $1`, [te]);
  // The same return's checklist built again from two lines that ask for the same two documents
  // (the individual and the business Schedule C) and a base return: each document once.
  await app.db.query(`DELETE FROM document_requests WHERE tax_engagement_id = $1`, [te]);
  await openChecklistRequest(app, {
    taxEngagementId: te, engagementId: eng.rows[0]!.engagement_id, contactId: c.contactId,
    itemCodes: ['IND_BASE_SINGLE', 'IND_SCH_C', 'BIZ_SCH_C'], taxYear: 2025, returnType: '1040',
  });
  assert.deepEqual((await items(te)).map((i) => i.doc_key), [
    'photo_id', 'prior_year_return', 'w2', 'forms_1099', 'business_income_records', 'business_expense_records',
  ]);
});

test('Ops reads received and missing on the return row; the portal reads the list in order with its status', async () => {
  const c = await client('Counts');
  const { te, year } = await accepted(c.contactId, ['IND_BASE_SINGLE']);
  const [first] = await items(te);
  await app.db.query(`UPDATE document_request_items SET status = 'received' WHERE id = $1`, [first!.id]);
  const list = await app.inject({ method: 'GET', url: `/tax-engagements?contactId=${c.contactId}`, headers: auth(ceo) });
  assert.equal(list.statusCode, 200, list.body);
  const row = list.json().taxEngagements.find((t: { id: string }) => t.id === te);
  assert.deepEqual([row.docs_received, row.docs_missing, row.docs_total], [1, 3, 4]);

  const portal = await app.inject({ method: 'GET', url: '/portal/checklists', headers: c.cookie });
  assert.equal(portal.statusCode, 200, portal.body);
  const [cl] = portal.json().checklists;
  assert.equal(cl.tax_year, year);
  assert.equal(cl.return_type, '1040');
  assert.deepEqual(cl.items.map((i: { docKey: string; status: string }) => `${i.docKey}:${i.status}`), [
    'photo_id:received', 'prior_year_return:pending', 'w2:pending', 'forms_1099:pending',
  ]);
  assert.ok(cl.items.every((i: { labelEs: string }) => i.labelEs), 'Spanish words on every item');
  // A return with no checklist reads null counts, not zeros.
  const none = await client('NoList');
  const other = await app.inject({ method: 'GET', url: `/portal/checklists`, headers: none.cookie });
  assert.deepEqual(other.json().checklists, []);
});

test('"Request documents" with the automation OFF: the stage moves, nothing is emailed, the hold is counted', async () => {
  await setAutomation(false);
  const c = await client('HeldReq');
  const { te } = await accepted(c.contactId, ['IND_BASE_SINGLE', 'IND_SCH_E_K1']);
  await atScheduled(te);
  const before = mail.length;
  const res = await app.inject({ method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(ceo), payload: { toStage: 'documents_requested' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().documentRequest, { emailed: false, reason: 'automation_off', missing: 5 });
  assert.equal(mail.slice(before).filter((m) => m.to === c.email).length, 0, 'held');
  const stage = await app.db.query<{ stage: string; docs_requested_at: Date | null }>(`SELECT stage, docs_requested_at FROM tax_engagements WHERE id = $1`, [te]);
  assert.equal(stage.rows[0]!.stage, 'documents_requested');
  assert.ok(stage.rows[0]!.docs_requested_at, 'the press records that documents were asked for');
  const autos = await app.inject({ method: 'GET', url: '/admin/automations', headers: auth(ceo) });
  const row = autos.json().automations.find((a: { key: string }) => a.key === 'document_checklist_request');
  assert.equal(row.enabled, false, 'seeded off');
  assert.ok(row.held_count >= 1, 'the held send is counted on the Automations row');
});

test('"Request documents" with the automation ON: the missing items, in order, in the client\'s language, with the portal link', async () => {
  await setAutomation(true);
  try {
    const c = await client('SendsEs', 'es');
    const { te, year } = await accepted(c.contactId, ['IND_BASE_SINGLE']);
    const [first] = await items(te);
    await app.db.query(`UPDATE document_request_items SET status = 'received' WHERE id = $1`, [first!.id]);
    await atScheduled(te);
    const before = mail.length;
    const res = await app.inject({ method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(ceo), payload: { toStage: 'documents_requested' } });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().documentRequest, { emailed: true, missing: 3 });
    const sent = mail.slice(before).filter((m) => m.to === c.email);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.subject, `Documentos para su declaración (Formulario 1040) de ${year}`);
    const body = sent[0]!.text;
    const order = ['La declaración de impuestos del año pasado', 'Los formularios W-2', 'Los formularios 1099'].map((s) => body.indexOf(s));
    assert.ok(order.every((i) => i >= 0), body);
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the checklist\'s order');
    assert.ok(!body.includes('Identificación con foto'), 'a received item is not asked for again');
    assert.ok(body.includes(config.PORTAL_BASE_URL), 'the portal link');
  } finally {
    await setAutomation(false);
  }
});

test('the recurring chase leaves a checklist alone until "Request documents" was pressed', async () => {
  await app.db.query(`UPDATE automations SET enabled = true WHERE key = 'document_chase'`);
  try {
    const c = await client('ChaseWait');
    const { te } = await accepted(c.contactId, ['IND_BASE_SINGLE']);
    await app.db.query(`UPDATE document_requests SET created_at = now() - interval '10 days' WHERE tax_engagement_id = $1`, [te]);
    const count = async () => (await app.db.query<{ n: number }>(`SELECT reminder_count AS n FROM document_requests WHERE tax_engagement_id = $1`, [te])).rows[0]!.n;
    await runDocumentChaseJob(app, '2099-01-01');
    assert.equal(await count(), 0, 'not chased before anyone asked');
    await app.db.query(`UPDATE tax_engagements SET docs_requested_at = now() WHERE id = $1`, [te]);
    await runDocumentChaseJob(app, '2099-01-02');
    assert.equal(await count(), 1, 'chased once "Request documents" was pressed');
  } finally {
    await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'document_chase'`);
  }
});

test('Admin edits the checklist: the words and on/off reach the next checklist, the one already opened keeps its own; a new row, a duplicate, the role proof', async () => {
  const first = await client('EditBefore');
  const { te: te1 } = await accepted(first.contactId, ['IND_BASE_SINGLE', 'IND_SCH_E_K1']);
  const list = await app.inject({ method: 'GET', url: '/admin/document-checklist', headers: auth(ceo) });
  assert.equal(list.statusCode, 200, list.body);
  const k1 = list.json().items.find((r: { item_code: string; doc_key: string }) => r.item_code === 'IND_SCH_E_K1' && r.doc_key === 'k1s');
  assert.ok(k1.item_name, 'the row names its price-book item');

  const patched = await app.inject({ method: 'PATCH', url: `/admin/document-checklist/${k1.id}`, headers: auth(ceo), payload: { labelEn: 'Every Schedule K-1 you received this year' } });
  assert.equal(patched.statusCode, 200, patched.body);
  const created = await app.inject({
    method: 'POST', url: '/admin/document-checklist', headers: auth(ceo),
    payload: { itemCode: 'IND_SCH_E_K1', docKey: 'k1_basis', labelEn: 'Your basis records for each K-1', labelEs: 'Sus registros de base de cada K-1' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const dup = await app.inject({
    method: 'POST', url: '/admin/document-checklist', headers: auth(ceo),
    payload: { itemCode: 'IND_SCH_E_K1', docKey: 'k1_basis', labelEn: 'x', labelEs: 'x' },
  });
  assert.equal(dup.statusCode, 409);
  const unknown = await app.inject({
    method: 'POST', url: '/admin/document-checklist', headers: auth(ceo),
    payload: { itemCode: 'NOT_AN_ITEM', docKey: 'x', labelEn: 'x', labelEs: 'x' },
  });
  assert.equal(unknown.statusCode, 422);
  const blank = await app.inject({ method: 'PATCH', url: `/admin/document-checklist/${k1.id}`, headers: auth(ceo), payload: { labelEs: '  ' } });
  assert.equal(blank.statusCode, 400, 'a label is never blanked');

  const second = await client('EditAfter');
  const { te: te2 } = await accepted(second.contactId, ['IND_BASE_SINGLE', 'IND_SCH_E_K1']);
  assert.deepEqual(k1Rows(await items(te2)).map((i) => i.label_en), ['Every Schedule K-1 you received this year', 'Your basis records for each K-1']);
  assert.deepEqual(k1Rows(await items(te1)).map((i) => i.label_en), ['Schedule K-1 from each partnership, S corporation, estate or trust'], 'the opened checklist keeps its words');

  // Switched off: the next checklist does not ask for it.
  await app.inject({ method: 'PATCH', url: `/admin/document-checklist/${created.json().id}`, headers: auth(ceo), payload: { active: false } });
  const third = await client('EditOff');
  const { te: te3 } = await accepted(third.contactId, ['IND_BASE_SINGLE', 'IND_SCH_E_K1']);
  assert.deepEqual(k1Rows(await items(te3)).map((i) => i.doc_key), ['k1s']);

  const audit = await app.db.query(`SELECT details FROM audit_log WHERE action = 'document_checklist.updated' AND object_id = $1`, [k1.id]);
  assert.equal(audit.rows.length, 1);
  assert.equal((audit.rows[0] as { details: { from: { label_en: string } } }).details.from.label_en, 'Schedule K-1 from each partnership, S corporation, estate or trust');

  // The role proof: a preparer (no admin.settings) is refused both doors.
  const refused = await app.inject({ method: 'PATCH', url: `/admin/document-checklist/${k1.id}`, headers: auth(preparer), payload: { active: false } });
  assert.equal(refused.statusCode, 403);
  const refusedList = await app.inject({ method: 'GET', url: '/admin/document-checklist', headers: auth(preparer) });
  assert.equal(refusedList.statusCode, 403);
});
