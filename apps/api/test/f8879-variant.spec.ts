/*
 * THE FORM 990 FAMILY AND WHICH 8879 THE PAPER IS (Brian, 2026-09-26, R66) — the API half.
 *
 *  · 990-PF and 990-T are return types: a return opens on them; their deadlines derive from the
 *    table (the fifth month, +6 on 8868); Record extension defaults to 8868 for the whole family;
 *  · the signed-authorization upload takes a form variant (8879, 8879-CORP, 8879-PE, 8879-TE),
 *    defaulted from the return type when unsaid, stored on the document row, read back on GET
 *    (the detail and the list); a form name the ruling does not list is refused before any byte lands;
 *  · correcting the variant goes through the R44 correction door, appended with a reason;
 *  · BIZ_990 prices the 990 and the 990-EZ; an accepted quote still creates a 990.
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, multipartBody, signed8879OnFile, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { addDays, extendedDeadline, originalDeadline, todayChicago } from '../src/modules/tax/deadlines.ts';
import { defaultExtensionForm } from '../src/modules/tax/extension.ts';
import { f8879VariantFor, F8879_VARIANTS } from '../src/modules/tax/signed-8879.ts';
import { itemPricesReturnType, returnTypeForItems } from '../src/modules/tax/return-type.ts';
import { currentPriceBookVersion } from '../src/modules/pricing/service.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };
let brian: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const today = todayChicago();
const SIGNED_ON = addDays(today, -10);
const PDF = Buffer.from('%PDF-1.4 synthetic test document - no real client data\n%%EOF');
const REASON = 'The paper on file is the exempt-organization form; the upload named the corporate one by mistake.';

async function staffWithToken(email: string, role: string, name: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('f8879_variant');
  const mailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  ana = await staffWithToken('ana-variant@example.test', 'tax_preparer', 'Synthetic Preparer');
  brian = await staffWithToken('brian-variant@example.test', 'ceo', 'Synthetic CEO');
});
after(async () => { await app.close(); });

/** A 2025 return of the given type at ready_to_file, on its own active engagement, with the letter and the lock. */
async function readyReturn(last: string, returnType: string, clientType = 'business'): Promise<{ id: string; contactId: string }> {
  const contactId = (await makeContact(app.db, { firstName: 'Synthetic', lastName: last, email: `${last.toLowerCase()}-variant@example.test` })).id;
  const version = await currentPriceBookVersion(app.db);
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status, period_key, price_book_version_id)
     VALUES ($1, 'tax', $3, 'active', '2025', $2) RETURNING id`,
    [contactId, version.id, `2025 ${returnType.toUpperCase()}`]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, stage, preparer_id, engagement_letter_signed_at, estimate_locked_at)
     VALUES ($1, 2025, $3::return_type, $4, 'ready_to_file', $2, now(), now()) RETURNING id`,
    [eng.rows[0]!.id, ana.id, returnType, clientType]
  );
  return { id: te.rows[0]!.id, contactId };
}
/** The row's own door: the scan, the signed date, the PTIN holder, and (optionally) which 8879 it is. */
async function upload8879(te: { id: string; contactId: string }, extra: Record<string, string> = {}) {
  const body = multipartBody(
    { contactId: te.contactId, category: 'signed_authorizations', taxEngagementId: te.id, signedOn: SIGNED_ON, preparerPtinHolderId: ana.id, ...extra },
    { field: 'file', filename: 'synthetic-signed-8879.pdf', contentType: 'application/pdf', data: PDF }
  );
  return app.inject({ method: 'POST', url: '/documents', headers: { ...auth(ana), ...body.headers }, payload: body.payload });
}
async function variantOnFile(id: string): Promise<string | null> {
  const { rows } = await app.db.query<{ v: string | null }>(
    `SELECT d.f8879_variant AS v FROM tax_engagements te JOIN documents d ON d.id = te.f8879_document_id WHERE te.id = $1`, [id]);
  return rows[0]?.v ?? null;
}

test('R72: a 1041 defaults to the 8879-F; the five variants are the API\'s list, and the documents constraint takes the fifth', async () => {
  assert.equal(f8879VariantFor('1041'), '8879-F');
  for (const [t, v] of [['1040', '8879'], ['1120s', '8879-CORP'], ['1065', '8879-PE'], ['990', '8879-TE']] as const) {
    assert.equal(f8879VariantFor(t), v, `${t} unchanged`);
  }
  assert.deepEqual([...F8879_VARIANTS], ['8879', '8879-CORP', '8879-PE', '8879-TE', '8879-F']);
  const { rows } = await app.db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'documents_f8879_variant_values'`);
  assert.match(rows[0]!.def, /'8879-F'/, 'migration 0127 lets the fifth variant onto a document row');
});

test('990-PF and 990-T are return types: a return opens on them, the deadlines derive from the table, the extension defaults to 8868 for the whole family', async () => {
  for (const t of ['990', '990ez', '990pf', '990t'] as const) {
    assert.equal(originalDeadline(t, 2025, 12), '2026-05-15', `${t}: the 15th day of the fifth month`);
    assert.equal(extendedDeadline(t, 2025, 12), '2026-11-16', `${t}: +6 months (Nov 15 2026 is a Sunday)`);
    assert.equal(defaultExtensionForm(t), '8868');
    assert.equal(f8879VariantFor(t), '8879-TE');
  }
  assert.equal(originalDeadline('990pf', 2026, 6), '2026-11-16', 'a June fiscal year end: the fifth month after is November');
  assert.notEqual(originalDeadline('990t', 2025, 12), originalDeadline('1120', 2025, 12), 'the 990 family is not on the corporate clock');

  const contactId = (await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Foundation', email: 'foundation-variant@example.test' })).id;
  const pf = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(ana), payload: {
    contactId, taxYear: 2025, returnType: '990pf', clientType: 'nonprofit', preparerId: ana.id,
    reason: 'Return opened by hand for the fixture; the foundation engaged by phone and the quote follows.',
  } });
  assert.equal(pf.statusCode, 201, pf.body);
  const ext = await app.inject({ method: 'POST', url: `/tax-engagements/${pf.json().id}/extension/filed`, headers: auth(ana), payload: {} });
  assert.equal(ext.statusCode, 200, ext.body);
  assert.equal(ext.json().form, '8868', 'unsaid, the form is 8868');
  assert.equal(ext.json().extendedDeadline, extendedDeadline('990pf', 2025, 12), 'derived from the table, never typed');
  const t990t = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(ana), payload: {
    contactId, taxYear: 2024, returnType: '990t', clientType: 'nonprofit', preparerId: ana.id,
    reason: 'Return opened by hand for the fixture; the unrelated business income return for the prior year.',
  } });
  assert.equal(t990t.statusCode, 201, t990t.body);
});

test('the upload takes the form variant: defaulted from the return type when unsaid, stored on the document row, read back by GET; a name the ruling does not list is refused before any byte lands', async () => {
  const expectations: Array<[string, string, string]> = [
    ['Individual', '1040', '8879'],
    ['Scorp', '1120s', '8879-CORP'],
    ['Ccorp', '1120', '8879-CORP'],
    ['Partners', '1065', '8879-PE'],
    ['Exempt', '990', '8879-TE'],
    ['Foundpf', '990pf', '8879-TE'],
  ];
  for (const [last, type, variant] of expectations) {
    const te = await readyReturn(last, type, type === '1040' ? 'individual' : type.startsWith('990') ? 'nonprofit' : 'business');
    const res = await upload8879(te);
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json().signed8879, true);
    assert.equal(await variantOnFile(te.id), variant, `${type} defaults to ${variant}`);
  }
  // Said explicitly, the person's word stands (an 8879-TE on a 1040 is odd, and not this door's to refuse).
  const said = await readyReturn('Saidso', '1040', 'individual');
  assert.equal((await upload8879(said, { f8879Variant: '8879-TE' })).statusCode, 201);
  assert.equal(await variantOnFile(said.id), '8879-TE');
  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${said.id}`, headers: auth(ana) })).json() as { taxEngagement: { f8879_variant: string } };
  assert.equal(detail.taxEngagement.f8879_variant, '8879-TE', 'the detail carries it for the row and the stepper');
  const list = (await app.inject({ method: 'GET', url: `/tax-engagements?contactId=${said.contactId}`, headers: auth(ana) })).json() as { taxEngagements: Array<{ id: string; f8879_variant: string | null }> };
  assert.equal(list.taxEngagements.find((r) => r.id === said.id)!.f8879_variant, '8879-TE', 'and so does the list the Returns card reads');
  const audit = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'signature.recorded_wet' AND object_id = $1`, [said.id]);
  assert.equal(audit.rows[0]!.details['f8879_variant'], '8879-TE', 'the upload audit names the form');

  // Refused by name, and nothing lands: no document row, no authorization.
  const bad = await readyReturn('Badform', '1120s');
  const before = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM documents WHERE contact_id = $1`, [bad.contactId]);
  const refused = await upload8879(bad, { f8879Variant: '8879-X' });
  assert.equal(refused.statusCode, 400, refused.body);
  assert.equal(refused.json().error, 'f8879_variant_invalid');
  assert.match(refused.json().message, new RegExp(F8879_VARIANTS.join(', ').replace(/[-]/g, '\\-')));
  const after = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM documents WHERE contact_id = $1`, [bad.contactId]);
  assert.equal(after.rows[0]!.n, before.rows[0]!.n, 'no orphan scan');
  assert.equal(await variantOnFile(bad.id), null);
});

test('correcting the form goes through the R44 correction door: appended with a reason, written on the document row, refused when unchanged or unlisted', async () => {
  const te = await readyReturn('Corrected', '1120s');
  await signed8879OnFile(app, te.id, ana.id, SIGNED_ON);
  assert.equal(await variantOnFile(te.id), '8879-CORP', 'the helper takes the default too');
  const filed = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/transition`, headers: auth(ana), payload: { toStage: 'filed', preparerPtinHolderId: ana.id, jurisdictions: ['federal'] } });
  assert.equal(filed.statusCode, 200, filed.body);

  const correct = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/filing-corrections`, headers: auth(ana), payload: { reason: REASON, ...payload } });
  const same = await correct({ f8879Variant: '8879-CORP' });
  assert.equal(same.statusCode, 409, same.body);
  assert.equal(same.json().error, 'nothing_to_correct');
  // R72 listed the 8879-F; an unlisted form is still refused.
  const unlisted = await correct({ f8879Variant: '8879-Z' });
  assert.equal(unlisted.statusCode, 400, unlisted.body);
  assert.equal(unlisted.json().error, 'f8879_variant_invalid');

  const ok = await correct({ f8879Variant: '8879-TE' });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.deepEqual(ok.json().fields, ['f8879_variant']);
  assert.equal(ok.json().before.f8879_variant, '8879-CORP');
  assert.equal(ok.json().after.f8879_variant, '8879-TE');
  assert.equal(await variantOnFile(te.id), '8879-TE', 'the document row reads the corrected form');
  const rows = await app.db.query<{ fields: string[]; reason: string }>(
    `SELECT fields, reason FROM tax_engagement_filing_corrections WHERE tax_engagement_id = $1`, [te.id]);
  assert.equal(rows.rows.length, 1);
  assert.deepEqual(rows.rows[0]!.fields, ['f8879_variant']);
  assert.equal(rows.rows[0]!.reason, REASON);
});

test('BIZ_990 prices the 990 and the 990-EZ; an accepted quote still creates a 990; 990-PF and 990-T have no line yet (the v6 proposal)', () => {
  assert.equal(returnTypeForItems(['BIZ_990'])!.returnType, '990');
  assert.equal(itemPricesReturnType('BIZ_990', '990'), true);
  assert.equal(itemPricesReturnType('BIZ_990', '990ez'), true, 'the book says "Form 990 / 990-EZ"');
  assert.equal(itemPricesReturnType('BIZ_990', '990pf'), false, 'no line in the book: proposed, not published');
  assert.equal(itemPricesReturnType('BIZ_990', '990t'), false);
  assert.equal(itemPricesReturnType('BIZ_1120S', '1120s'), true);
  assert.equal(itemPricesReturnType('BIZ_1120S', '1120'), false);
  assert.equal(itemPricesReturnType('NOT_AN_ITEM', '990'), false);
});
