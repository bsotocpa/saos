/*
 * THE 2026-09-19 WALK (Brian). What the server side of it must hold:
 *   - an 8879 signed date is a past fact: a date after today is refused, an earlier one authorizes;
 *   - a held send is dated and past tense, when it is recorded and when an old row is read;
 *   - the actor on an acceptance email is the person who released the report;
 *   - the preparer queue shows leadership everyone's returns on request, and a preparer only their own;
 *   - a business added from the client page carries its formation date with provenance, and
 *     "primary at creation" clears the previous primary rather than adding a second.
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, signed8879OnFile, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import type { Mailer } from '../src/mailer.ts';
import { recordSigned8879 } from '../src/modules/tax/signed-8879.ts';
import { holdLine, drainOutbox, enqueueEffect } from '../src/outbox.ts';
import { sendLogForInvoice } from '../src/modules/billing/notices.ts';
import { createInvoice } from '../src/modules/billing/service.ts';
import { ingestReport, releaseReport } from '../src/modules/tax/efile-ack.ts';
import { todayChicago, addDays } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };
let mara: TestStaff & { token: string };
const sent: Array<{ to: string; subject: string }> = [];
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role} ${email.split('@')[0]}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('sept19walk');
  const mailer: Mailer = { transport: 'console', async send(m) { sent.push({ to: String(m.to), subject: m.subject ?? '' }); return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  brian = await staffWithToken('brian-walk@example.test', 'ceo');
  ana = await staffWithToken('ana-walk@example.test', 'tax_preparer');
  mara = await staffWithToken('mara-walk@example.test', 'tax_preparer');
});
after(async () => { await app.close(); });

/** A business return at a stage, on its own client, assigned to a preparer. */
async function businessReturn(last: string, preparerId: string, stage = 'intake_started'): Promise<{ contactId: string; businessId: string; teId: string; engagementId: string }> {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: last, email: `${last.toLowerCase()}-walk@example.test` });
  const biz = await app.inject({ method: 'POST', url: `/contacts/${c.id}/businesses`, headers: auth(brian), payload: { name: `Synthetic ${last}, LLC`, ein: '55-5555555', entityType: 's_corp', state: 'IL' } });
  assert.equal(biz.statusCode, 201, biz.body);
  const businessId = biz.json().id as string;
  const te = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(ana), payload: { reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows', contactId: c.id, businessId, taxYear: 2025, returnType: '1120s', clientType: 'business', preparerId } });
  assert.equal(te.statusCode, 201, te.body);
  const teId = te.json().id as string;
  if (stage !== 'intake_started') await app.db.query(`UPDATE tax_engagements SET stage = $2::tax_stage, engagement_letter_signed_at = now(), estimate_locked_at = now() WHERE id = $1`, [teId, stage]);
  return { contactId: c.id, businessId, teId, engagementId: te.json().engagementId as string };
}

test('the 8879 signed date is a past fact: tomorrow is refused, the real earlier date authorizes', async () => {
  const r = await businessReturn('Signeddate', ana.id);
  const doc = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, tax_engagement_id, category, filename, minio_bucket, minio_key, uploaded_by_type)
     VALUES ($1, $2, 'signed_authorizations', 'synthetic-8879-corp.pdf', 'saos-signed-docs', 'test/' || gen_random_uuid()::text || '.pdf', 'staff') RETURNING id`,
    [r.contactId, r.teId]);
  await assert.rejects(
    () => recordSigned8879(app, { staffId: ana.id, label: ana.fullName }, { taxEngagementId: r.teId, documentId: doc.rows[0]!.id, signedOn: addDays(todayChicago(), 1), preparerPtinHolderId: ana.id }),
    (e: { code?: string }) => e.code === 'signed_date_in_future'
  );
  const past = addDays(todayChicago(), -9);
  await recordSigned8879(app, { staffId: ana.id, label: ana.fullName }, { taxEngagementId: r.teId, documentId: doc.rows[0]!.id, signedOn: past, preparerPtinHolderId: ana.id });
  const row = await app.db.query<{ signed: string }>(`SELECT f8879_signed_at::date::text AS signed FROM tax_engagements WHERE id = $1`, [r.teId]);
  assert.equal(row.rows[0]!.signed, past, 'the date on the scan, not the upload day');
});

test('a held send is dated and past tense, when it is held and when an old row is read', async () => {
  assert.match(holdLine(new Date('2026-09-10T15:00:00Z')), /^held on 2026-09-10 — automation was off at the time$/);
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Heldsend', email: 'heldsend-walk@example.test' });
  const item = await app.db.query<{ amount_cents: number }>(`SELECT amount_cents FROM price_book_items WHERE is_active AND amount_cents > 0 ORDER BY amount_cents LIMIT 1`);
  const inv = await createInvoice(app, { type: 'staff', id: brian.id, label: brian.fullName }, { contactId: c.id, lines: [{ description: 'Held', unitCents: item.rows[0]!.amount_cents }], send: false, issued: true });
  // An old row, recorded before 2026-09-19, in the words it was written with.
  await app.db.query(
    `INSERT INTO outbox (effect, payload, status, contact_id, object_type, object_id, last_error, created_at)
     VALUES ('invoice.void_notice', '{}'::jsonb, 'suppressed', $1, 'invoice', $2, 'held — the automation is off (Admin → Automations)', '2026-09-10T02:56:06Z')`,
    [c.id, inv.id]);
  const log = await sendLogForInvoice(app, inv.id);
  const held = log.find((r) => r.source === 'outbox');
  assert.ok(held);
  assert.equal(held!.detail, 'held on 2026-09-09 — automation was off at the time', 'dated on the Chicago day it was held, past tense');
  // A new hold, through the drain, with the automation off.
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'void_notice'`);
  await app.db.query(`UPDATE invoices SET status = 'void', voided_at = now(), void_reason = 'synthetic' WHERE id = $1`, [inv.id]).catch(() => undefined);
  await enqueueEffect(app, { effect: 'invoice.void_notice', payload: { invoiceId: inv.id }, contactId: c.id, objectType: 'invoice', objectId: inv.id });
  await drainOutbox(app);
  const fresh = await app.db.query<{ last_error: string | null; status: string }>(`SELECT last_error, status::text AS status FROM outbox WHERE object_id = $1 ORDER BY created_at DESC LIMIT 1`, [inv.id]);
  if (fresh.rows[0]!.status === 'suppressed') assert.match(fresh.rows[0]!.last_error ?? '', new RegExp(`^held on ${todayChicago()} — automation was off at the time$`));
});

test('the actor on an acceptance email is the person who released the report', async () => {
  await app.db.query(`UPDATE automations SET enabled = true WHERE key = 'efile_acknowledgment'`);
  const r = await businessReturn('Released', ana.id, 'filed');
  await signed8879OnFile(app, r.teId, ana.id, addDays(todayChicago(), -3));
  await app.db.query(`UPDATE tax_engagements SET preparer_ptin_holder_id = COALESCE(preparer_ptin_holder_id, $2) WHERE id = $1`, [r.teId, ana.id]);
  const report = [
    'Entity Name,EIN,Tax Year,Return Type,Agency,Status,Submission ID,Ack Date',
    `"Synthetic Released, LLC",5555,2025,1120S,Federal,Accepted,R-FED-1,09/18/2026`,
    `"Synthetic Released, LLC",5555,2025,1120S,IL,Accepted,R-IL-1,09/18/2026`,
  ].join('\n');
  const ingested = await ingestReport(app, { id: brian.id, label: brian.fullName }, { filename: 'released.csv', text: report, today: todayChicago() });
  assert.equal(ingested.queued, 2, `both rows matched: ${JSON.stringify(ingested)}`);
  await releaseReport(app, { id: brian.id, label: brian.fullName }, ingested.reportId);
  sent.length = 0;
  await drainOutbox(app);
  assert.equal(sent.length, 2, 'two acceptance emails left');
  const audits = await app.db.query<{ actor_type: string; actor_id: string | null; actor_label: string }>(
    `SELECT actor_type::text AS actor_type, actor_id, actor_label FROM audit_log WHERE action = 'efile_ack.notice_sent' AND contact_id = $1`, [r.contactId]);
  assert.equal(audits.rows.length, 2);
  for (const a of audits.rows) {
    assert.equal(a.actor_type, 'staff', 'the send names a person, not the outbox');
    assert.equal(a.actor_id, brian.id);
    assert.equal(a.actor_label, brian.fullName);
  }
});

test('the preparer queue: leadership reads everyone on request; a preparer reads only their own', async () => {
  const mine = await businessReturn('Queueana', ana.id);
  const theirs = await businessReturn('Queuemara', mara.id);
  const own = await app.inject({ method: 'GET', url: '/my-queue', headers: auth(ana) });
  const ownIds = (own.json().queue as Array<{ id: string }>).map((q) => q.id);
  assert.ok(ownIds.includes(mine.teId) && !ownIds.includes(theirs.teId), 'a preparer sees their own');
  const still = await app.inject({ method: 'GET', url: '/my-queue?all=1', headers: auth(ana) });
  assert.ok(!(still.json().queue as Array<{ id: string }>).some((q) => q.id === theirs.teId), 'a preparer asking for everyone still gets their own');
  const ceoOwn = await app.inject({ method: 'GET', url: '/my-queue', headers: auth(brian) });
  assert.equal((ceoOwn.json().queue as unknown[]).length, 0, 'nothing is assigned to the CEO');
  const everyone = await app.inject({ method: 'GET', url: '/my-queue?all=1', headers: auth(brian) });
  const allIds = (everyone.json().queue as Array<{ id: string }>).map((q) => q.id);
  assert.ok(allIds.includes(mine.teId) && allIds.includes(theirs.teId), 'the CEO sees every open return');
  assert.equal(everyone.json().scoped, false);
});

test('a business added from the client page: formation date with provenance, and primary at creation clears the previous primary', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Addbiz', email: 'addbiz-walk@example.test' });
  const future = await app.inject({ method: 'POST', url: `/contacts/${c.id}/businesses`, headers: auth(brian), payload: { name: 'Synthetic Tomorrow LLC', entityType: 'llc', state: 'IL', formationDate: addDays(todayChicago(), 1) } });
  assert.equal(future.statusCode, 400, future.body);
  assert.equal(future.json().error, 'formation_date_in_future');
  const first = await app.inject({ method: 'POST', url: `/contacts/${c.id}/businesses`, headers: auth(brian), payload: { name: 'Synthetic First LLC', entityType: 'llc', state: 'IL', ein: '12-3456789', formationDate: '2021-03-04' } });
  assert.equal(first.statusCode, 201, first.body);
  const firstRow = await app.db.query<{ formation_date: string; formation_date_source: string; is_primary: boolean }>(
    `SELECT b.formation_date::text AS formation_date, b.formation_date_source, m.is_primary FROM businesses b JOIN business_members m ON m.business_id = b.id WHERE b.id = $1`, [first.json().id]);
  assert.equal(firstRow.rows[0]!.formation_date, '2021-03-04');
  assert.equal(firstRow.rows[0]!.formation_date_source, 'staff_verified');
  assert.equal(firstRow.rows[0]!.is_primary, true, 'the first business is primary');
  const second = await app.inject({ method: 'POST', url: `/contacts/${c.id}/businesses`, headers: auth(brian), payload: { name: 'Synthetic Second LLC', entityType: 's_corp', state: 'IL' } });
  assert.equal(second.statusCode, 201, second.body);
  assert.equal((await app.db.query<{ is_primary: boolean }>(`SELECT is_primary FROM business_members WHERE business_id = $1`, [second.json().id])).rows[0]!.is_primary, false, 'a second business is not primary unless asked');
  const third = await app.inject({ method: 'POST', url: `/contacts/${c.id}/businesses`, headers: auth(brian), payload: { name: 'Synthetic Third LLC', entityType: 'llc', state: 'IL', setPrimary: true } });
  assert.equal(third.statusCode, 201, third.body);
  const primaries = await app.db.query<{ business_id: string }>(`SELECT business_id FROM business_members WHERE contact_id = $1 AND is_primary`, [c.id]);
  assert.deepEqual(primaries.rows.map((p) => p.business_id), [third.json().id], 'exactly one primary, the one asked for');
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'business.primary_cleared' AND object_id = $1`, [first.json().id])).rows.length, 1, 'the clear is on the record');
});
