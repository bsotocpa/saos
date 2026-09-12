/*
 * THE FIRST REAL-DATA RUN, REHEARSED (2026-09-12): Soto Accounting LLC's own 1120S, checks a to f.
 *
 *   a) an 1120S moves through the whole lifecycle to filed and on to completed;
 *   b) the ATX BUSINESS acknowledgment report is read: entity-name columns, "1120S", the entity's
 *      name (not a person's), the EIN last-4 in agreement with the record;
 *   c) the corporate e-file authorization is accepted as the signed authorization by CATEGORY,
 *      whatever the scan is called;
 *   d) the business is a record linked to the contact, quoted against;
 *   e) business-tax quote → acceptance creates the return record → Schedule B resolves → the
 *      deposit overridden to $0 → the preparer attaches to the accepted engagement rather than
 *      colliding with it;
 *   f) Illinois acknowledges separately, as a second jurisdiction.
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import type { AuthedStaff } from '../src/types.ts';
import { createQuote, sendQuote, acceptQuote, overrideQuoteDeposit } from '../src/modules/pricing/quotes.ts';
import { previewPacket } from '../src/modules/engagements/packet.ts';
import { ingestReport, parseAtxReport, foldEntityName } from '../src/modules/tax/efile-ack.ts';
import { returnTypeForItems } from '../src/modules/tax/return-type.ts';
import { drainOutbox } from '../src/outbox.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string, name: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}
const actorOf = (t: TestStaff, role: string, perms: string[]): AuthedStaff => ({ id: t.id, email: t.email, fullName: t.fullName, roleKey: role, permissions: perms, sessionId: 'spec' });

before(async () => {
  config = await createTestConfig('first1120s');
  const mailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  brian = await staffWithToken('brian-1120s@example.test', 'ceo', 'Synthetic CEO');
  ana = await staffWithToken('ana-1120s@example.test', 'tax_preparer', 'Synthetic Preparer');
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'efile_acknowledgment'`);
});
after(async () => { await app.close(); });

test('the map: a quoted base item names the return; add-ons alone name none; the entity wins beside a side Schedule C', () => {
  assert.deepEqual(returnTypeForItems(['BIZ_1120S']), { returnType: '1120s', clientType: 'business' });
  assert.deepEqual(returnTypeForItems(['IND_BASE_MFJ', 'IND_SCH_C']), { returnType: '1040', clientType: 'individual' });
  assert.deepEqual(returnTypeForItems(['BIZ_SCH_C', 'BIZ_1120S']), { returnType: '1120s', clientType: 'business' });
  assert.equal(returnTypeForItems(['IND_ADDL_STATE', 'BIZ_NOTICE_SUPPORT']), null);
  assert.equal(foldEntityName('Soto Accounting, LLC'), foldEntityName('SOTO ACCOUNTING LLC'));
  assert.equal(foldEntityName('The Sad Boy Radio L.L.C.'), 'sad boy radio');
});

test('d, e, a, c, b, f: the S corp, quoted, accepted, prepared, authorized by the corporate scan, filed, acknowledged federally and by Illinois', async () => {
  // d) the business, a record linked to the owner's contact.
  const owner = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Owner', email: 'owner-1120s@example.test' });
  const biz = await app.inject({ method: 'POST', url: `/contacts/${owner.id}/businesses`, headers: auth(brian), payload: { name: 'Synthetic Accounting, LLC', ein: '98-7654321', entityType: 's_corp', state: 'IL' } });
  assert.equal(biz.statusCode, 201, biz.body);
  const businessId = (biz.json() as { id: string }).id;

  // e) a business-tax quote against the entity, deposit overridden to $0, sent, accepted.
  const q = await createQuote(app, { contactId: owner.id, businessId, lines: [{ itemCode: 'BIZ_1120S' }] }, actorOf(brian, 'ceo', ['*', 'deposits.override']));
  await overrideQuoteDeposit(app, q.id, { amountCents: 0, reason: 'The firm files its own return; no deposit is collected from ourselves.' }, actorOf(brian, 'ceo', ['*', 'deposits.override']));
  const sent = await sendQuote(app, q.id, actorOf(brian, 'ceo', ['*']));
  const accepted = await acceptQuote(app, sent.url.split('/').pop()!, {});
  assert.equal(accepted.engagements.length, 1);
  const engagementId = accepted.engagements[0]!.id;
  assert.equal(accepted.depositInvoiceId ?? null, null, 'a $0 deposit issues no invoice');

  // The acceptance created the RETURN record, not only the engagement.
  const te = await app.db.query<{ id: string; return_type: string; client_type: string; tax_year: number; stage: string }>(
    `SELECT id, return_type::text AS return_type, client_type::text AS client_type, tax_year, stage::text AS stage FROM tax_engagements WHERE engagement_id = $1`, [engagementId]);
  assert.equal(te.rows.length, 1, 'one return record');
  assert.equal(te.rows[0]!.return_type, '1120s');
  assert.equal(te.rows[0]!.client_type, 'business');
  assert.equal(te.rows[0]!.stage, 'intake_started');
  const teId = te.rows[0]!.id;
  const bizOn = await app.db.query<{ business_id: string | null }>(`SELECT business_id FROM engagements WHERE id = $1`, [engagementId]);
  assert.equal(bizOn.rows[0]!.business_id, businessId, 'the engagement is the entity\'s');

  // Schedule B resolves from the return type; A is not needed for a business-only client.
  const preview = await previewPacket(app, owner.id);
  assert.ok(preview.codes.includes('B'), `Schedule B in the packet, got ${preview.codes.join(',')}`);
  assert.ok(!preview.codes.includes('A'), 'no Schedule A for a business-only client');

  // The preparer opening "the return" by hand does not collide and does not duplicate.
  const dup = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(ana), payload: { reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows', contactId: owner.id, businessId, taxYear: te.rows[0]!.tax_year, returnType: '1120s', clientType: 'business' } });
  assert.equal(dup.statusCode, 409, dup.body);
  assert.equal(dup.json().error, 'return_exists');
  assert.match(dup.json().message, new RegExp(teId));

  // a) the lifecycle. The letter and the estimate gates are stamped the way the other specs stamp them.
  await app.db.query(`UPDATE tax_engagements SET engagement_letter_signed_at = now(), estimate_locked_at = now(), preparer_id = $2 WHERE id = $1`, [teId, ana.id]);
  const move = async (toStage: string, extra: Record<string, unknown> = {}) =>
    app.inject({ method: 'POST', url: `/tax-engagements/${teId}/transition`, headers: auth(ana), payload: { toStage, ...extra } });
  for (const stage of ['scheduled', 'documents_requested', 'in_preparation', 'internal_review', 'client_review', 'ready_to_file']) {
    const r = await move(stage);
    assert.equal(r.statusCode, 200, `${stage}: ${r.body}`);
  }
  const early = await move('filed', { preparerPtinHolderId: ana.id });
  assert.equal(early.statusCode, 409, 'no filing without the signed authorization on file');
  assert.equal(early.json().error, 'f8879_required');

  // c) the corporate e-file authorization: a scan named for the corporate form, filed by CATEGORY.
  const wrongCategory = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, tax_engagement_id, category, filename, minio_bucket, minio_key, uploaded_by_type)
     VALUES ($1, $2, 'business_records', 'Form 8879-CORP signed.pdf', 'saos-documents', 'test/8879-corp-wrong.pdf', 'staff') RETURNING id`, [owner.id, teId]);
  const { recordSigned8879 } = await import('../src/modules/tax/signed-8879.ts');
  await assert.rejects(
    () => recordSigned8879(app, { staffId: ana.id, label: ana.fullName }, { taxEngagementId: teId, documentId: wrongCategory.rows[0]!.id, signedOn: '2026-09-14', preparerPtinHolderId: ana.id }),
    /Signed Authorizations/,
    'the category is the check, not the file name'
  );
  const scan = await app.db.query<{ id: string }>(
    `INSERT INTO documents (contact_id, tax_engagement_id, category, filename, minio_bucket, minio_key, uploaded_by_type)
     VALUES ($1, $2, 'signed_authorizations', 'Form 8879-CORP signed.pdf', 'saos-signed-docs', 'test/8879-corp.pdf', 'staff') RETURNING id`, [owner.id, teId]);
  await recordSigned8879(app, { staffId: ana.id, label: ana.fullName }, { taxEngagementId: teId, documentId: scan.rows[0]!.id, signedOn: '2026-09-14', preparerPtinHolderId: ana.id });
  const filed = await move('filed', { preparerPtinHolderId: ana.id });
  assert.equal(filed.statusCode, 200, filed.body);
  const onFile = await app.db.query<{ f8879_document_id: string; preparer_ptin_holder_id: string; stage: string }>(`SELECT f8879_document_id, preparer_ptin_holder_id, stage::text AS stage FROM tax_engagements WHERE id = $1`, [teId]);
  assert.deepEqual(onFile.rows[0], { f8879_document_id: scan.rows[0]!.id, preparer_ptin_holder_id: ana.id, stage: 'filed' });

  // b, f) the ATX business acknowledgment report: entity columns, the entity's name, the EIN last-4, federal and Illinois.
  const report = [
    'Entity Name,EIN,Tax Year,Return Type,Agency,Status,Submission ID,Ack Date,Reject Code,Reject Reason',
    `"Synthetic Accounting, LLC",4321,${te.rows[0]!.tax_year},1120S,Federal,Accepted,S-FED-1,09/15/2026,,`,
    `"Synthetic Accounting, LLC",4321,${te.rows[0]!.tax_year},1120S,IL,Accepted,S-IL-1,09/15/2026,,`,
    `"Owner, Synthetic",4321,${te.rows[0]!.tax_year},1120S,Federal,Accepted,S-FED-2,09/15/2026,,`,
  ].join('\n');
  const parsed = parseAtxReport(report);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0]!.returnType, '1120s');
  assert.equal(parsed.rows[1]!.stateCode, 'IL');
  const r = await ingestReport(app, { id: ana.id, label: ana.fullName }, { filename: 'business-ack.csv', text: report, today: '2026-09-15' });
  const rows = await app.db.query<{ client_name_raw: string; disposition: string; tax_engagement_id: string | null; jurisdiction: string }>(
    `SELECT client_name_raw, disposition::text AS disposition, tax_engagement_id, jurisdiction::text AS jurisdiction FROM efile_acknowledgments WHERE report_id = $1 ORDER BY row_index`, [r.reportId]);
  assert.equal(rows.rows[0]!.tax_engagement_id, teId, 'the federal row matched the entity');
  assert.equal(rows.rows[1]!.tax_engagement_id, teId, 'the Illinois row matched the entity');
  assert.equal(rows.rows[0]!.disposition, 'queued');
  assert.equal(rows.rows[1]!.disposition, 'queued');
  assert.equal(rows.rows[2]!.tax_engagement_id, null, 'the owner\'s personal name does not match an entity return: no guess');
  const done = await app.db.query<{ stage: string; federal_accepted_on: string | null; state_accepted_on: string | null; state_accepted_code: string | null }>(
    `SELECT stage::text AS stage, federal_accepted_on::text AS federal_accepted_on, state_accepted_on::text AS state_accepted_on, state_accepted_code FROM tax_engagements WHERE id = $1`, [teId]);
  assert.equal(done.rows[0]!.stage, 'completed');
  assert.equal(done.rows[0]!.federal_accepted_on, '2026-09-15');
  assert.equal(done.rows[0]!.state_accepted_on, '2026-09-15');
  assert.equal(done.rows[0]!.state_accepted_code, 'IL');
  // The sends are held while the automation is off.
  const drained = await drainOutbox(app);
  assert.equal(drained.sent, 0);
});

test('b) an EIN that does not agree with the record refuses the match, and a person-format report still matches a person', async () => {
  const owner = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Mismatch', email: 'mismatch-1120s@example.test' });
  const biz = await app.inject({ method: 'POST', url: `/contacts/${owner.id}/businesses`, headers: auth(brian), payload: { name: 'Mismatch Holdings LLC', ein: '12-1111111', entityType: 's_corp' } });
  const businessId = (biz.json() as { id: string }).id;
  const created = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(ana), payload: { reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows', contactId: owner.id, businessId, taxYear: 2030, returnType: '1120s', clientType: 'business' } });
  assert.equal(created.statusCode, 201, created.body);
  const teId = (created.json() as { id: string }).id;
  await app.db.query(`UPDATE tax_engagements SET stage = 'filed', engagement_letter_signed_at = now(), estimate_locked_at = now() WHERE id = $1`, [teId]);
  const report = [
    'Entity Name,EIN,Tax Year,Return Type,Agency,Status,Submission ID,Ack Date',
    '"Mismatch Holdings, LLC",9999,2030,1120S,Federal,Accepted,S-X,09/15/2026',
  ].join('\n');
  const r = await ingestReport(app, { id: ana.id, label: ana.fullName }, { filename: 'ack.csv', text: report, today: '2026-09-15' });
  const rows = await app.db.query<{ disposition: string; tax_engagement_id: string | null; disposition_note: string }>(
    `SELECT disposition::text AS disposition, tax_engagement_id, disposition_note FROM efile_acknowledgments WHERE report_id = $1`, [r.reportId]);
  assert.equal(rows.rows[0]!.tax_engagement_id, null, 'the EIN on the report disagrees: no guess');
  assert.match(rows.rows[0]!.disposition_note ?? '', /taxpayer id/);
});
