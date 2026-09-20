/*
 * STEP-7 CONTROLS ON THE RETURN'S PAGE (Brian, 2026-09-19, item 2) — the API half.
 *
 *  · the legal next stage(s) per stage: forward only, no on_hold / withdrawn, no step back; from
 *    rejected the re-file path is the one forward move;
 *  · GET /tax-engagements/:id says the quoted range and the price-book version it is read against,
 *    whether a signed authorization is on file, the assigned preparer, and who may hold the PTIN;
 *  · a final fee inside the quoted range needs no reason; outside it, refused without one (naming
 *    the range) and audited with one, under the action the money line reads;
 *  · filed with no 8879 on file refuses f8879_required; with the 8879 and a PTIN holder it issues
 *    the invoice through createInvoice (the row, and invoice.created on the audit log);
 *  · a bookkeeper gets 403 from all three routes;
 *  · above a LOCKED estimate the final fee needs the scope-creep category AND the reason, and the
 *    category is never defaulted to 'other' (2026-09-19 evening, ruling 1);
 *  · the filed transition declares the return's jurisdictions, validated, and GET says what the
 *    modal should start from (2026-09-19 evening, ruling 2).
 *
 * Plus the 2026-09-20 rulings:
 *  · the client's packet signature in the portal stamps the engagement letter on every return the
 *    client has, a return opened later inherits it while the letter stands, and the paper path is an
 *    upload against the return — the bare staff route stamps nothing any more (ruling 10);
 *  · a return gets the firm's only active tax preparer at creation, preparation is refused until
 *    somebody is named, and the assign route refuses an inactive or wrong-role choice (ruling 11);
 *  · an extension records which form went in and the day it was filed, refuses a future date, and
 *    takes its extended deadline from the deadline table rather than the request (ruling 12).
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
import type { AuthedStaff } from '../src/types.ts';
import { TAX_STAGES, legalNextStages } from '../src/modules/tax/pipeline.ts';
import { createPacket, recordMasterSignature } from '../src/modules/engagements/packet.ts';
import { defaultExtensionForm } from '../src/modules/tax/extension.ts';
import { addDays, extendedDeadline, todayChicago } from '../src/modules/tax/deadlines.ts';
import { currentPriceBookVersion } from '../src/modules/pricing/service.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };
let brian: TestStaff & { token: string };
let marian: TestStaff & { token: string };
let ceoActor: AuthedStaff;
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string, name: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('return_controls');
  const mailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  ana = await staffWithToken('ana-controls@example.test', 'tax_preparer', 'Synthetic Preparer');
  brian = await staffWithToken('brian-controls@example.test', 'ceo', 'Synthetic CEO');
  marian = await staffWithToken('marian-controls@example.test', 'bookkeeper', 'Synthetic Bookkeeper');
  ceoActor = { id: brian.id, email: brian.email, permissions: ['*'] } as AuthedStaff;
});
after(async () => { await app.close(); });

/**
 * A quoted 1120S at a given stage: the engagement carries the scope snapshot an accepted quote
 * leaves (#47) — the BIZ_1120S line under the price book in force — with the letter signed so the
 * gates past 'scheduled' are open, and Ana assigned.
 */
async function quotedReturn(
  last: string,
  stage: string,
  opts: { lockEstimate?: boolean; letterSigned?: boolean; preparer?: boolean; taxYear?: number; contactId?: string } = {}
): Promise<{ id: string; contactId: string; engagementId: string }> {
  const contactId = opts.contactId
    ?? (await makeContact(app.db, { firstName: 'Synthetic', lastName: last, email: `${last.toLowerCase()}-controls@example.test` })).id;
  const taxYear = opts.taxYear ?? 2025;
  const version = await currentPriceBookVersion(app.db);
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status, period_key, price_book_version_id)
     VALUES ($1, 'tax', $2 || ' 1120S', 'active', $2, $3) RETURNING id`,
    [contactId, String(taxYear), version.id]
  );
  await app.db.query(
    `INSERT INTO engagement_scope_items (engagement_id, price_book_version_id, item_code, description_en, quantity, unit_cents, line_cents)
     SELECT $1, $2, item_code, name_en, 1, amount_cents, amount_cents FROM price_book_items WHERE version_id = $2 AND item_code = 'BIZ_1120S'`,
    [eng.rows[0]!.id, version.id]
  );
  // The letter and the preparer are on by default, because most tests want a return past the gates.
  // The 2026-09-20 rulings turn each one off in turn, to prove the gate that asks for it.
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, stage, preparer_id, engagement_letter_signed_at, estimate_locked_at)
     VALUES ($1, $5, '1120s', 'business', $2::tax_stage,
             CASE WHEN $6 THEN $3::uuid ELSE NULL END,
             CASE WHEN $7 THEN now() ELSE NULL END,
             CASE WHEN $4 THEN now() ELSE NULL END) RETURNING id`,
    [
      eng.rows[0]!.id, stage, ana.id, Boolean(opts.lockEstimate), taxYear,
      opts.preparer !== false, opts.letterSigned !== false,
    ]
  );
  return { id: te.rows[0]!.id, contactId, engagementId: eng.rows[0]!.id };
}

async function bookPrice(itemCode: string): Promise<{ cents: number; version: number }> {
  const version = await currentPriceBookVersion(app.db);
  const { rows } = await app.db.query<{ amount_cents: number }>(
    `SELECT amount_cents FROM price_book_items WHERE version_id = $1 AND item_code = $2`, [version.id, itemCode]);
  return { cents: rows[0]!.amount_cents, version: version.versionNumber };
}

test('the legal next stage(s) per stage: forward only, never on_hold/withdrawn, never a step back', () => {
  const expected: Record<string, string[]> = {
    intake_started: ['scheduled'],
    scheduled: ['documents_requested'],
    documents_requested: ['pending_client_response', 'in_preparation'],
    pending_client_response: ['in_preparation'],
    in_preparation: ['internal_review'],
    internal_review: ['client_review'],
    client_review: ['ready_to_file'],
    ready_to_file: ['filed'],
    filed: ['completed'],
    rejected: ['ready_to_file'], // the re-file path is the one forward move after a rejection
    completed: [],
    on_hold: [],
    withdrawn: [],
  };
  for (const stage of TAX_STAGES) {
    assert.deepEqual(legalNextStages(stage), expected[stage], `from ${stage}`);
  }
});

test('GET /tax-engagements/:id carries the quoted range under the book in force, the 8879 state, the preparer and the PTIN-holder options', async () => {
  const te = await quotedReturn('Detail', 'ready_to_file');
  const price = await bookPrice('BIZ_1120S');
  const res = await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) });
  assert.equal(res.statusCode, 200, res.body);
  const j = res.json() as {
    quoted_range: { min_cents: number; max_cents: number; price_book_version: number } | null;
    legal_next_stages: string[]; signed_authorization_on_file: boolean;
    default_jurisdictions: string[]; declared_jurisdictions: string[];
    assigned_preparer: { id: string; name: string } | null; staff_options: Array<{ id: string; name: string }>;
  };
  // No quote behind the scope snapshot, so the fallback stands: the base return item under the book
  // in force, and a flat item is a range of one number (ruling 13 sums the whole quote when there is one).
  assert.deepEqual(j.quoted_range, { min_cents: price.cents, max_cents: price.cents, price_book_version: price.version });
  assert.deepEqual(j.legal_next_stages, ['filed']);
  assert.deepEqual(j.default_jurisdictions, ['federal'], 'a contact with no state on file suggests federal alone');
  assert.deepEqual(j.declared_jurisdictions, [], 'nothing is declared until the return is filed');
  assert.equal(j.signed_authorization_on_file, false);
  assert.deepEqual(j.assigned_preparer, { id: ana.id, name: ana.fullName });
  const ids = j.staff_options.map((o) => o.id);
  assert.ok(ids.includes(ana.id) && ids.includes(brian.id), 'the preparer and the CEO may hold the PTIN');
  assert.ok(!ids.includes(marian.id), 'the bookkeeper may not');

  // Once the estimate is locked, the locked range is the quoted range.
  const lock = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/estimate`, headers: auth(ana), payload: { minCents: 60000, maxCents: 80000 } });
  assert.equal(lock.statusCode, 200, lock.body);
  const again = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) })).json() as { quoted_range: { min_cents: number; max_cents: number } };
  assert.equal(again.quoted_range.min_cents, 60000);
  assert.equal(again.quoted_range.max_cents, 80000);
});

test('final fee inside the quoted range needs no reason; outside it is refused without one, naming the range, and audited with one', async () => {
  const te = await quotedReturn('Fee', 'ready_to_file');
  const price = await bookPrice('BIZ_1120S');

  const inside = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana), payload: { finalFeeCents: price.cents } });
  assert.equal(inside.statusCode, 200, inside.body);
  assert.equal(inside.json().outsideQuotedRange, false);
  const none = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'tax_engagement.final_fee_outside_quote' AND object_id = $1`, [te.id]);
  assert.equal(none.rows.length, 0, 'inside the range registers nothing on the money line');

  const above = price.cents + 15000;
  const refused = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana), payload: { finalFeeCents: above } });
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().error, 'final_fee_reason_required');
  assert.match(refused.json().message, new RegExp(`\\$${(price.cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`), 'names the range');
  assert.match(refused.json().message, new RegExp(`price book v${price.version}`), 'names the version');
  const still = await app.db.query<{ final_fee_cents: number }>(`SELECT final_fee_cents FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(still.rows[0]!.final_fee_cents, price.cents, 'the refused amount did not land');

  // A conversation artifact is not a reason (reasons.ts): refused at the door.
  const pointer = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana), payload: { finalFeeCents: above, reason: 'per ruling 2 as discussed' } });
  assert.equal(pointer.statusCode, 400, pointer.body);

  const reasoned = await app.inject({
    method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana),
    payload: { finalFeeCents: above, reason: 'Two additional state returns were prepared beyond the quoted federal and Illinois filing.' },
  });
  assert.equal(reasoned.statusCode, 200, reasoned.body);
  assert.equal(reasoned.json().outsideQuotedRange, true);
  const audit = await app.db.query<{ actor_label: string; details: Record<string, unknown> }>(
    `SELECT actor_label, details FROM audit_log WHERE action = 'tax_engagement.final_fee_outside_quote' AND object_id = $1`, [te.id]);
  assert.equal(audit.rows.length, 1, 'one money-line row');
  assert.equal(audit.rows[0]!.actor_label, ana.fullName);
  assert.equal(audit.rows[0]!.details['final_fee_cents'], above);
  assert.equal(audit.rows[0]!.details['quoted_min_cents'], price.cents);
  assert.equal(audit.rows[0]!.details['quoted_max_cents'], price.cents);
  assert.match(String(audit.rows[0]!.details['reason']), /additional state returns/);

  // Below the range is outside too.
  const below = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana), payload: { finalFeeCents: price.cents - 5000 } });
  assert.equal(below.statusCode, 409);
  assert.equal(below.json().error, 'final_fee_reason_required');
});

test('above a locked estimate BOTH the category and the reason are required, and the category is never defaulted to other', async () => {
  const te = await quotedReturn('Creep', 'ready_to_file');
  const lock = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/estimate`, headers: auth(ana), payload: { minCents: 60000, maxCents: 80000 } });
  assert.equal(lock.statusCode, 200, lock.body);
  const reason = 'Late documents arrived after the estimate and a prior-year cleanup was needed first.';

  // Neither: the refusal names both, in the words the modal renders beside the fields.
  const bare = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana), payload: { finalFeeCents: 95000 } });
  assert.equal(bare.statusCode, 409, bare.body);
  assert.equal(bare.json().error, 'scope_creep_reason_required');
  assert.match(bare.json().message, /scope-creep category/, 'names the missing category');
  assert.match(bare.json().message, /a reason/, 'and the missing reason');
  assert.match(bare.json().message, /above the locked estimate/i, 'and why both are being asked for');

  // THE DEFECT THIS RULING REPLACES: a reason alone used to be stored as category 'other'. Refused now.
  const reasonOnly = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana), payload: { finalFeeCents: 95000, reason } });
  assert.equal(reasonOnly.statusCode, 409, reasonOnly.body);
  assert.match(reasonOnly.json().message, /scope-creep category/, 'the category is what is missing');
  assert.doesNotMatch(reasonOnly.json().message, /a reason and/, 'the reason is not also reported missing');

  // A category alone is refused too: the reason is what the next reader uses.
  const categoryOnly = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana), payload: { finalFeeCents: 95000, scopeCreepReason: 'late_docs' } });
  assert.equal(categoryOnly.statusCode, 409, categoryOnly.body);
  assert.match(categoryOnly.json().message, /a reason is missing/);

  const nothingLanded = await app.db.query<{ final_fee_cents: number | null; scope_creep_reason: string | null }>(
    `SELECT final_fee_cents, scope_creep_reason::text AS scope_creep_reason FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(nothingLanded.rows[0]!.final_fee_cents, null, 'three refusals left nothing behind');
  assert.equal(nothingLanded.rows[0]!.scope_creep_reason, null);

  // Both: the category is the one chosen, and the reason is its description.
  const ok = await app.inject({
    method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana),
    payload: { finalFeeCents: 95000, scopeCreepReason: 'late_docs', reason },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().scopeCreepFlag, true);
  const row = await app.db.query<{ scope_creep_reason: string; scope_creep_description: string }>(
    `SELECT scope_creep_reason::text AS scope_creep_reason, scope_creep_description FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(row.rows[0]!.scope_creep_reason, 'late_docs', 'the category the person chose, never \'other\' by default');
  assert.match(row.rows[0]!.scope_creep_description, /Late documents/);
  const flagged = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'tax_engagement.scope_creep_flagged' AND object_id = $1`, [te.id]);
  assert.equal(flagged.rows.length, 1);
  assert.equal(flagged.rows[0]!.details['reason'], 'late_docs');
});

test('outside the quoted range but NOT above a locked estimate: the reason alone, as before, and no category is asked for', async () => {
  // The estimate is unlocked, so the quoted range is the base return item under the book in force
  // (no quote stands behind this fixture's scope). Above it the fee is outside the range but there
  // is no locked top to be over.
  const te = await quotedReturn('Nolock', 'ready_to_file');
  const price = await bookPrice('BIZ_1120S');
  const above = price.cents + 12000;
  const bare = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana), payload: { finalFeeCents: above } });
  assert.equal(bare.statusCode, 409, bare.body);
  assert.equal(bare.json().error, 'final_fee_reason_required', 'the range rule, not the scope-creep rule');
  assert.doesNotMatch(bare.json().message, /category/, 'no category is asked for without a locked estimate');

  const ok = await app.inject({
    method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana),
    payload: { finalFeeCents: above, reason: 'Two additional state returns were prepared beyond the quoted federal filing.' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json(), { status: 'ok', scopeCreepFlag: false, outsideQuotedRange: true });
  const row = await app.db.query<{ scope_creep_reason: string | null; scope_creep_flag: boolean }>(
    `SELECT scope_creep_reason::text AS scope_creep_reason, scope_creep_flag FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(row.rows[0]!.scope_creep_flag, false);
  assert.equal(row.rows[0]!.scope_creep_reason, null, 'nothing is filed under a category nobody chose');
});

test('filed with no 8879 on file refuses f8879_required; with the 8879 and a PTIN holder it issues the invoice through createInvoice', async () => {
  const te = await quotedReturn('Filed', 'ready_to_file');
  const price = await bookPrice('BIZ_1120S');
  const fee = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana), payload: { finalFeeCents: price.cents } });
  assert.equal(fee.statusCode, 200, fee.body);
  const noInvoiceYet = await app.db.query(`SELECT 1 FROM invoices WHERE tax_engagement_id = $1`, [te.id]);
  assert.equal(noInvoiceYet.rows.length, 0, 'setting the fee creates no invoice');

  const unsigned = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/transition`, headers: auth(ana), payload: { toStage: 'filed', preparerPtinHolderId: ana.id } });
  assert.equal(unsigned.statusCode, 409, unsigned.body);
  assert.equal(unsigned.json().error, 'f8879_required');

  await signed8879OnFile(app, te.id, ana.id);
  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) })).json() as { signed_authorization_on_file: boolean };
  assert.equal(detail.signed_authorization_on_file, true);

  const filed = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/transition`, headers: auth(ana), payload: { toStage: 'filed', preparerPtinHolderId: ana.id } });
  assert.equal(filed.statusCode, 200, filed.body);
  assert.deepEqual(filed.json(), { status: 'ok', from: 'ready_to_file', to: 'filed', jurisdictions: ['federal'] },
    'the filing declares where it went; this client has no state on file, so federal alone');

  // THE MONEY DOOR: transitionStage → invoiceForFiledEngagement → createInvoice. The row and its audit.
  const inv = await app.db.query<{ id: string; total_cents: number; status: string }>(
    `SELECT id, total_cents, status::text AS status FROM invoices WHERE tax_engagement_id = $1`, [te.id]);
  assert.equal(inv.rows.length, 1, 'one final-fee invoice');
  assert.equal(inv.rows[0]!.total_cents, price.cents);
  assert.notEqual(inv.rows[0]!.status, 'draft', 'payable the moment the filing commits');
  const created = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'invoice.created' AND object_id = $1`, [inv.rows[0]!.id]);
  assert.equal(created.rows.length, 1, 'createInvoice wrote invoice.created');
  const holder = await app.db.query<{ preparer_ptin_holder_id: string; filed_date: string }>(
    `SELECT preparer_ptin_holder_id, filed_date::text AS filed_date FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(holder.rows[0]!.preparer_ptin_holder_id, ana.id);
  assert.ok(holder.rows[0]!.filed_date);
});

test('the filed transition declares the jurisdictions: validated, stored on the return, and read back by GET', async () => {
  const te = await quotedReturn('Jurisdictions', 'ready_to_file');
  const price = await bookPrice('BIZ_1120S');
  await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana), payload: { finalFeeCents: price.cents } });
  await signed8879OnFile(app, te.id, ana.id);
  const file = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/transition`, headers: auth(ana), payload: { toStage: 'filed', preparerPtinHolderId: ana.id, ...payload } });

  const noFederal = await file({ jurisdictions: ['IL'] });
  assert.equal(noFederal.statusCode, 400, noFederal.body);
  assert.equal(noFederal.json().error, 'federal_jurisdiction_required');
  const lower = await file({ jurisdictions: ['federal', 'il'] });
  assert.equal(lower.statusCode, 400, lower.body);
  assert.equal(lower.json().error, 'jurisdiction_invalid');
  assert.match(lower.json().message, /two-letter state code in upper case/);
  const tooLong = await file({ jurisdictions: ['federal', 'ILL'] });
  assert.equal(tooLong.statusCode, 400, tooLong.body);
  assert.equal(tooLong.json().error, 'jurisdiction_invalid');
  const twice = await file({ jurisdictions: ['federal', 'IL', 'IL'] });
  assert.equal(twice.statusCode, 400, twice.body);
  assert.equal(twice.json().error, 'jurisdiction_duplicated');
  const stillOpen = await app.db.query<{ stage: string }>(`SELECT stage::text AS stage FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(stillOpen.rows[0]!.stage, 'ready_to_file', 'a refused list leaves the return unfiled');

  const filed = await file({ jurisdictions: ['federal', 'WI', 'IL'] });
  assert.equal(filed.statusCode, 200, filed.body);
  assert.deepEqual(filed.json().jurisdictions, ['federal', 'IL', 'WI'], 'federal first, then the states in order');
  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) })).json() as {
    declared_jurisdictions: string[]; default_jurisdictions: string[]; jurisdictions_awaiting: string[];
  };
  assert.deepEqual(detail.declared_jurisdictions, ['federal', 'IL', 'WI']);
  assert.deepEqual(detail.default_jurisdictions, ['federal'], 'the default is still what the address suggests');
  assert.deepEqual(detail.jurisdictions_awaiting, ['federal', 'IL', 'WI'], 'a filing waits on every jurisdiction it declared');
  const rows = await app.db.query<{ jurisdiction: string; accepted_on: string | null }>(
    `SELECT jurisdiction, accepted_on::text AS accepted_on FROM tax_engagement_jurisdictions WHERE tax_engagement_id = $1 ORDER BY jurisdiction`, [te.id]);
  assert.deepEqual(rows.rows.map((r) => r.jurisdiction).sort(), ['IL', 'WI', 'federal']);
  assert.ok(rows.rows.every((r) => r.accepted_on === null), 'declared is not accepted');
  const declared = await app.db.query<{ details: { jurisdictions?: string[] } }>(
    `SELECT details FROM audit_log WHERE action = 'tax_engagement.stage_changed' AND object_id = $1 AND details->>'to' = 'filed'`, [te.id]);
  assert.deepEqual(declared.rows[0]!.details.jurisdictions, ['federal', 'IL', 'WI'], 'the filing records where it went');
});

test('role proof: a bookkeeper gets 403 from estimate, final-fee and transition; the CEO holds them by wildcard', async () => {
  const te = await quotedReturn('Role', 'ready_to_file');
  const price = await bookPrice('BIZ_1120S');
  for (const [url, payload] of [
    [`/tax-engagements/${te.id}/estimate`, { minCents: 60000, maxCents: 80000 }],
    [`/tax-engagements/${te.id}/final-fee`, { finalFeeCents: price.cents }],
    [`/tax-engagements/${te.id}/transition`, { toStage: 'filed', preparerPtinHolderId: ana.id }],
  ] as const) {
    const res = await app.inject({ method: 'POST', url, headers: auth(marian), payload });
    assert.equal(res.statusCode, 403, `${url}: ${res.body}`);
    assert.equal(res.json().permission, 'engagements.tax.manage');
  }
  // The session tells the Ops shell the same thing the routes enforce.
  const me = (await app.inject({ method: 'GET', url: '/auth/me', headers: auth(marian) })).json() as { permissions: string[] };
  assert.ok(!me.permissions.includes('engagements.tax.manage') && !me.permissions.includes('*'), 'the bookkeeper does not hold it');
  const ceo = (await app.inject({ method: 'GET', url: '/auth/me', headers: auth(brian) })).json() as { permissions: string[] };
  assert.ok(ceo.permissions.includes('*'));
  const asCeo = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/estimate`, headers: auth(brian), payload: { minCents: 60000, maxCents: 80000 } });
  assert.equal(asCeo.statusCode, 200, asCeo.body);
});

/*
 * ═══ 2026-09-20, RULING 10: THE ENGAGEMENT LETTER ═════════════════════════════════════════════
 *
 * One signature, every return it covers; a return opened later inherits it while it stands; and the
 * client who signed on paper is stamped by the scan, through the same door the 8879 takes. The bare
 * staff route that stamped the gate with now() and nothing behind it is gone.
 */

test('the packet signature in the portal stamps the engagement letter on every return the client has', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Packetletter', email: 'packetletter-controls@example.test' });
  // Two years, two returns, neither stamped: the defect was that signing covered none of them.
  const older = await quotedReturn('Packetletter', 'scheduled', { contactId: c.id, taxYear: 2024, letterSigned: false });
  const newer = await quotedReturn('Packetletter', 'scheduled', { contactId: c.id, taxYear: 2025, letterSigned: false });
  const before = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
      WHERE e.contact_id = $1 AND te.engagement_letter_signed_at IS NOT NULL`, [c.id]);
  assert.equal(before.rows[0]!.n, 0, 'nothing is stamped before the signature');

  const packet = await createPacket(app, c.id, ceoActor);
  const signed = await recordMasterSignature(app, packet.packetId, { method: 'portal_esign' });
  assert.equal(signed.contactId, c.id);

  const after = await app.db.query<{ id: string; signed: string | null }>(
    `SELECT te.id, te.engagement_letter_signed_at::text AS signed
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
      WHERE e.contact_id = $1 ORDER BY te.tax_year`, [c.id]);
  assert.equal(after.rows.length, 2);
  assert.ok(after.rows.every((r) => r.signed), 'one signature stamped both returns');
  assert.deepEqual(after.rows.map((r) => r.id).sort(), [older.id, newer.id].sort());

  // Keyed on the contact, and the packet's own audit row says which returns it stamped.
  const audit = await app.db.query<{ details: { tax_returns_stamped?: string[] } }>(
    `SELECT details FROM audit_log WHERE action = 'packet.signed' AND object_id = $1`, [packet.packetId]);
  assert.equal(audit.rows.length, 1);
  assert.deepEqual([...(audit.rows[0]!.details.tax_returns_stamped ?? [])].sort(), [older.id, newer.id].sort());

  // And gate 1 is actually open now: the return moves past Scheduled.
  const moved = await app.inject({ method: 'POST', url: `/tax-engagements/${newer.id}/transition`, headers: auth(ana), payload: { toStage: 'documents_requested' } });
  assert.equal(moved.statusCode, 200, moved.body);
});

test('a return created after the signature inherits the stamp while the letter stands; one created before it does not', async () => {
  // No letter yet: the new return starts unstamped and gate 1 says so.
  const fresh = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Inherit', email: 'inherit-controls@example.test' });
  const unsigned = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows', contactId: fresh.id, taxYear: 2025, returnType: '1040' },
  });
  assert.equal(unsigned.statusCode, 201, unsigned.body);
  assert.equal(unsigned.json().engagementLetterInherited, false, 'nothing is inherited from a letter nobody signed');
  const notStamped = await app.db.query<{ signed: string | null }>(
    `SELECT engagement_letter_signed_at::text AS signed FROM tax_engagements WHERE id = $1`, [unsigned.json().id]);
  assert.equal(notStamped.rows[0]!.signed, null);

  // The client signs; a return opened for the NEXT year inherits the stamp without asking again.
  await app.db.query(`UPDATE contacts SET engagement_letter_status = 'signed' WHERE id = $1`, [fresh.id]);
  const later = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows', contactId: fresh.id, taxYear: 2026, returnType: '1040' },
  });
  assert.equal(later.statusCode, 201, later.body);
  assert.equal(later.json().engagementLetterInherited, true);
  const stamped = await app.db.query<{ signed: string | null }>(
    `SELECT engagement_letter_signed_at::text AS signed FROM tax_engagements WHERE id = $1`, [later.json().id]);
  assert.ok(stamped.rows[0]!.signed, 'the standing letter covers the return opened under it');
});

test('the paper letter door: the upload stamps the return, and refuses a future date and a date before the year closed', async () => {
  const te = await quotedReturn('Paperletter', 'scheduled', { letterSigned: false });
  const upload = (signedOn: string, filename: string) => {
    const body = multipartBody(
      { contactId: te.contactId, category: 'signed_authorizations', taxEngagementId: te.id, engagementLetterSignedOn: signedOn },
      { field: 'file', filename, contentType: 'application/pdf', data: Buffer.from('%PDF-1.4 synthetic engagement letter\n%%EOF') }
    );
    return app.inject({ method: 'POST', url: '/documents', headers: { ...auth(ana), ...body.headers }, payload: body.payload });
  };

  // Gate 1 is shut, and the return says so.
  const blocked = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/transition`, headers: auth(ana), payload: { toStage: 'documents_requested' } });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().error, 'engagement_letter_required');

  // A signature dated after today is not a signature anybody has seen.
  const future = await upload(addDays(todayChicago(), 3), 'synthetic-letter-future.pdf');
  assert.equal(future.statusCode, 409, future.body);
  assert.equal(future.json().error, 'signed_date_in_future');
  assert.match(future.json().message, /after today/);

  // And one dated before the return's tax year closed cannot authorize that year.
  const tooEarly = await upload('2025-06-30', 'synthetic-letter-early.pdf');
  assert.equal(tooEarly.statusCode, 409, tooEarly.body);
  assert.equal(tooEarly.json().error, 'signed_before_year_end');

  const stillNull = await app.db.query<{ signed: string | null }>(
    `SELECT engagement_letter_signed_at::text AS signed FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(stillNull.rows[0]!.signed, null, 'two refusals stamped nothing');

  // The real date on the paper: the upload IS the stamp.
  const signedOn = '2026-02-10';
  const ok = await upload(signedOn, 'synthetic-letter-signed.pdf');
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().signedEngagementLetter, true);
  const row = await app.db.query<{ signed: string | null }>(
    `SELECT engagement_letter_signed_at::date::text AS signed FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(row.rows[0]!.signed, signedOn, 'the date on the scan, not the date of the upload');
  const contact = await app.db.query<{ status: string }>(
    `SELECT engagement_letter_status::text AS status FROM contacts WHERE id = $1`, [te.contactId]);
  assert.equal(contact.rows[0]!.status, 'signed', 'the client letter stands, so the next return inherits it');
  const envelope = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM signature_envelopes
      WHERE tax_engagement_id = $1 AND type = 'engagement_letter' AND status = 'completed' AND signed_document_id IS NOT NULL`, [te.id]);
  assert.equal(envelope.rows[0]!.n, 1, 'one queryable envelope, with the scan on it');

  // Gate 1 is open, and a second upload is refused rather than stamping twice.
  const moved = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/transition`, headers: auth(ana), payload: { toStage: 'documents_requested' } });
  assert.equal(moved.statusCode, 200, moved.body);
  const again = await upload(signedOn, 'synthetic-letter-again.pdf');
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error, 'engagement_letter_already_on_file');
});

test('the bare wet-signature route no longer stamps the letter: it says where the door moved to', async () => {
  const te = await quotedReturn('Wetgone', 'scheduled', { letterSigned: false });
  const res = await app.inject({
    method: 'POST', url: `/tax-engagements/${te.id}/signatures/wet`, headers: auth(ana),
    payload: { type: 'engagement_letter', note: 'signed across the desk' },
  });
  assert.equal(res.statusCode, 410, res.body);
  assert.equal(res.json().error, 'engagement_letter_is_an_upload');
  assert.match(res.json().message, /Signed Authorizations/);
  const untouched = await app.db.query<{ signed: string | null }>(
    `SELECT engagement_letter_signed_at::text AS signed FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(untouched.rows[0]!.signed, null, 'a retired route stamps nothing');
});

/*
 * ═══ 2026-09-20, RULING 11: THE PREPARER ══════════════════════════════════════════════════════
 */

test('a new return gets the only active tax preparer the firm has, and GET says who that is', async () => {
  const fresh = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Soleprep', email: 'soleprep-controls@example.test' });
  const created = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows', contactId: fresh.id, taxYear: 2025, returnType: '1040' },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().preparerId, ana.id, 'one preparer in the firm, one answer to who prepares this');
  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${created.json().id}`, headers: auth(ana) })).json() as {
    assigned_preparer: { id: string; name: string } | null; sole_tax_preparer_id: string | null;
    staff_options: Array<{ id: string }>;
  };
  assert.deepEqual(detail.assigned_preparer, { id: ana.id, name: ana.fullName });
  assert.equal(detail.sole_tax_preparer_id, ana.id, 'what the Assign preparer select opens on');
  assert.ok(detail.staff_options.some((o) => o.id === brian.id), 'the CEO may take a return himself');
});

test('preparation is refused until a preparer is named; the assign route refuses an inactive or wrong-role choice', async () => {
  const te = await quotedReturn('Noprep', 'documents_requested', { lockEstimate: true, preparer: false });
  const start = () => app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/transition`, headers: auth(ana), payload: { toStage: 'in_preparation' } });

  const refused = await start();
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.json().error, 'preparer_required');
  assert.match(refused.json().message, /Assign the preparer/);
  const stillThere = await app.db.query<{ stage: string }>(`SELECT stage::text AS stage FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(stillThere.rows[0]!.stage, 'documents_requested', 'a refused move left the return where it was');

  const assign = (staffId: string) =>
    app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/preparer`, headers: auth(ana), payload: { staffId } });

  const wrongRole = await assign(marian.id);
  assert.equal(wrongRole.statusCode, 409, wrongRole.body);
  assert.equal(wrongRole.json().error, 'preparer_wrong_role');
  assert.match(wrongRole.json().message, new RegExp(marian.fullName), 'named, not a code');

  // An inactive preparer is not a preparer.
  const gone = await makeStaff(app.db, config, { email: 'gone-controls@example.test', name: 'Synthetic Departed', role: 'tax_preparer', password: 'tax_preparer-password-123456' });
  await app.db.query(`UPDATE staff SET is_active = false WHERE id = $1`, [gone.id]);
  const inactive = await assign(gone.id);
  assert.equal(inactive.statusCode, 409, inactive.body);
  assert.equal(inactive.json().error, 'preparer_inactive');

  const ok = await assign(ana.id);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json().preparer, { id: ana.id, name: ana.fullName });
  const audited = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'tax_engagement.preparer_assigned' AND object_id = $1`, [te.id]);
  assert.equal(audited.rows.length, 1, 'assignment is on the record');
  assert.equal(audited.rows[0]!.details['preparer_id'], ana.id);

  const started = await start();
  assert.equal(started.statusCode, 200, started.body);

  // The bookkeeper cannot assign anybody.
  const forbidden = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/preparer`, headers: auth(marian), payload: { staffId: ana.id } });
  assert.equal(forbidden.statusCode, 403, forbidden.body);
  assert.equal(forbidden.json().permission, 'engagements.tax.manage');
});

/*
 * ═══ 2026-09-20, RULING 12: THE EXTENSION ═════════════════════════════════════════════════════
 */

test('recording an extension: the form, the day it was filed, and a derived deadline nobody types', async () => {
  const te = await quotedReturn('Extension', 'in_preparation', { lockEstimate: true });
  const file = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/extension/filed`, headers: auth(ana), payload });

  // A filed date after today is not a filing anybody has made.
  const future = await file({ form: '7004', filedOn: addDays(todayChicago(), 2) });
  assert.equal(future.statusCode, 409, future.body);
  assert.equal(future.json().error, 'extension_filed_date_in_future');
  assert.match(future.json().message, /after today/);
  const nothing = await app.db.query<{ filed: boolean; form: string | null }>(
    `SELECT extension_filed AS filed, extension_form AS form FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(nothing.rows[0]!.filed, false, 'a refused date filed no extension');
  assert.equal(nothing.rows[0]!.form, null);

  // Only the two real forms exist.
  const notAForm = await file({ form: '8868', filedOn: todayChicago() });
  assert.equal(notAForm.statusCode, 400, notAForm.body);

  // An 1120S extends on 7004, and the deadline is what the table derives — never a typed date.
  assert.equal(defaultExtensionForm('1120s'), '7004');
  assert.equal(defaultExtensionForm('1040'), '4868', 'an individual return extends on 4868');
  const filedOn = '2026-03-10';
  const ok = await file({ form: '7004', filedOn });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().form, '7004');
  assert.equal(ok.json().filedOn, filedOn);
  const derived = extendedDeadline('1120s', 2025, 12);
  assert.equal(ok.json().extendedDeadline, derived, 'the deadline table, not the request body');
  const row = await app.db.query<{ filed: boolean; form: string | null; filed_on: string | null; deadline: string | null }>(
    `SELECT extension_filed AS filed, extension_form AS form, extension_filed_date::text AS filed_on,
            extended_deadline::text AS deadline
       FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(row.rows[0]!.filed, true);
  assert.equal(row.rows[0]!.form, '7004');
  assert.equal(row.rows[0]!.filed_on, filedOn);
  assert.equal(row.rows[0]!.deadline, derived);
  const audited = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'tax_engagement.extension_filed' AND object_id = $1`, [te.id]);
  assert.equal(audited.rows[0]!.details['extension_form'], '7004');
  assert.equal(audited.rows[0]!.details['filed_on'], filedOn);

  // The row reads it back, which is what the badge on the card shows.
  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) })).json() as {
    taxEngagement: { extension_filed: boolean; extension_form: string | null; extended_deadline: string | null };
  };
  assert.equal(detail.taxEngagement.extension_filed, true);
  assert.equal(detail.taxEngagement.extension_form, '7004');
  assert.equal(detail.taxEngagement.extended_deadline, derived);
});

test('recording an extension with neither answer: the form follows the return type and the date is today', async () => {
  const te = await quotedReturn('Extdefault', 'in_preparation', { lockEstimate: true });
  const res = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/extension/filed`, headers: auth(ana), payload: {} });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().form, '7004', 'an 1120S extends on 7004 without being told');
  assert.equal(res.json().filedOn, todayChicago());
});

/*
 * ═══ 2026-09-20, RULING 13: THE QUOTED RANGE IS THE WHOLE ACCEPTED QUOTE ═══════════════════════
 *
 * The range a final fee is read against used to be the BASE return line alone, so every quote with a
 * schedule on it read low: the exact figure the client accepted landed "outside the quoted range"
 * and the preparer was asked to justify quoted scope as if it were scope creep. It is now the sum of
 * the accepted quote's lines for this return — min of mins, max of maxes, a flat line contributing
 * its amount to both — read from the engagement's scope snapshot at the price-book version that
 * quote pinned, never the book in force.
 */

/** An accepted quote whose lines are snapshotted onto the engagement (#47): base plus add-ons. */
async function acceptedQuoteReturn(
  last: string,
  items: readonly string[]
): Promise<{ id: string; contactId: string; engagementId: string; quoteId: string }> {
  const contactId = (await makeContact(app.db, {
    firstName: 'Synthetic', lastName: last, email: `${last.toLowerCase()}-controls@example.test`,
  })).id;
  const version = await currentPriceBookVersion(app.db);
  const quote = await app.db.query<{ id: string }>(
    `INSERT INTO quotes (contact_id, status, price_book_version_id, accepted_at) VALUES ($1, 'accepted', $2, now()) RETURNING id`,
    [contactId, version.id]
  );
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status, period_key, price_book_version_id)
     VALUES ($1, 'tax', '2025 1120S', 'active', '2025', $2) RETURNING id`,
    [contactId, version.id]
  );
  for (const [i, code] of items.entries()) {
    await app.db.query(
      `INSERT INTO engagement_scope_items
         (engagement_id, source_quote_id, price_book_version_id, item_code, description_en, quantity, unit_cents, line_cents, sort_order)
       SELECT $1, $2, $3, item_code, name_en, 1, amount_cents, amount_cents, $5
         FROM price_book_items WHERE version_id = $3 AND item_code = $4`,
      [eng.rows[0]!.id, quote.rows[0]!.id, version.id, code, i]
    );
  }
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, stage, preparer_id, engagement_letter_signed_at)
     VALUES ($1, 2025, '1120s', 'business', 'ready_to_file', $2, now()) RETURNING id`,
    [eng.rows[0]!.id, ana.id]
  );
  return { id: te.rows[0]!.id, contactId, engagementId: eng.rows[0]!.id, quoteId: quote.rows[0]!.id };
}

test('the quoted range covers the accepted quote’s schedules, and a fee equal to the quoted scope is inside it', async () => {
  const te = await acceptedQuoteReturn('Schedule', ['BIZ_1120S', 'BIZ_ADDL_STATE']);
  const base = await bookPrice('BIZ_1120S');
  const schedule = await bookPrice('BIZ_ADDL_STATE');
  const quoted = base.cents + schedule.cents;

  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) })).json() as {
    quoted_range: { min_cents: number; max_cents: number; price_book_version: number } | null;
  };
  assert.deepEqual(
    detail.quoted_range,
    { min_cents: quoted, max_cents: quoted, price_book_version: base.version },
    'the base line AND the schedule, at the version the quote pinned'
  );
  assert.ok(quoted > base.cents, 'the schedule is really on the quote (the old range stopped at the base line)');

  // The exact figure the client accepted: inside the range, and nothing is asked for.
  const fee = await app.inject({
    method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana),
    payload: { finalFeeCents: quoted },
  });
  assert.equal(fee.statusCode, 200, fee.body);
  assert.deepEqual(fee.json(), { status: 'ok', scopeCreepFlag: false, outsideQuotedRange: false });
  const audited = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = 'tax_engagement.final_fee_outside_quote' AND object_id = $1`, [te.id]);
  assert.equal(audited.rows.length, 0, 'quoted scope is not a departure from the quote');

  // Above the whole quote it is still outside, and still refused without a reason.
  const over = await app.inject({
    method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana),
    payload: { finalFeeCents: quoted + 5000 },
  });
  assert.equal(over.statusCode, 409, over.body);
  assert.equal(over.json().error, 'final_fee_reason_required');
});

test('a ranged line widens the quoted range at both ends; a pass-through is never part of the fee', async () => {
  // IND_CPA_LETTER is priced as a RANGE in the book; the base 1120S is flat. Min of mins, max of maxes.
  const te = await acceptedQuoteReturn('Ranged', ['BIZ_1120S', 'IND_CPA_LETTER']);
  const version = await currentPriceBookVersion(app.db);
  const ranged = await app.db.query<{ price_min_cents: number; price_max_cents: number }>(
    `SELECT price_min_cents, price_max_cents FROM price_book_items WHERE version_id = $1 AND item_code = 'IND_CPA_LETTER'`,
    [version.id]);
  const base = await bookPrice('BIZ_1120S');
  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) })).json() as {
    quoted_range: { min_cents: number; max_cents: number } | null;
  };
  assert.equal(detail.quoted_range!.min_cents, base.cents + ranged.rows[0]!.price_min_cents);
  assert.equal(detail.quoted_range!.max_cents, base.cents + ranged.rows[0]!.price_max_cents);

  // A pass-through line is shown to the client and is never our fee: it moves neither end.
  await app.db.query(
    `INSERT INTO engagement_scope_items
       (engagement_id, source_quote_id, price_book_version_id, item_code, description_en, quantity, unit_cents, line_cents, is_pass_through, sort_order)
     SELECT $1, $2, $3, item_code, name_en, 1, amount_cents, amount_cents, true, 9
       FROM price_book_items WHERE version_id = $3 AND item_code = 'PASS_QBO'`,
    [te.engagementId, te.quoteId, version.id]);
  const again = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) })).json() as {
    quoted_range: { min_cents: number; max_cents: number } | null;
  };
  assert.deepEqual(again.quoted_range, detail.quoted_range, 'the pass-through changed neither end');
});

test('the locked estimate still wins over the quote, and a return with no accepted quote falls back to the base item', async () => {
  const te = await acceptedQuoteReturn('Lockwins', ['BIZ_1120S', 'BIZ_ADDL_STATE']);
  const lock = await app.inject({
    method: 'POST', url: `/tax-engagements/${te.id}/estimate`, headers: auth(ana), payload: { minCents: 90000, maxCents: 95000 } });
  assert.equal(lock.statusCode, 200, lock.body);
  const locked = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) })).json() as {
    quoted_range: { min_cents: number; max_cents: number } | null;
  };
  assert.deepEqual({ min: locked.quoted_range!.min_cents, max: locked.quoted_range!.max_cents }, { min: 90000, max: 95000 });

  // No quote behind the scope (a return opened by hand): the base item under the book in force, as before.
  const byHand = await quotedReturn('Noquote', 'ready_to_file');
  const base = await bookPrice('BIZ_1120S');
  const fallback = (await app.inject({ method: 'GET', url: `/tax-engagements/${byHand.id}`, headers: auth(ana) })).json() as {
    quoted_range: { min_cents: number; max_cents: number; price_book_version: number } | null;
  };
  assert.deepEqual(fallback.quoted_range, { min_cents: base.cents, max_cents: base.cents, price_book_version: base.version });
});

test('role proof (ruling 13): the range is read by the same GET the controls use — a bookkeeper is refused, a preparer carries the full range', async () => {
  const te = await acceptedQuoteReturn('Rangerole', ['BIZ_1120S', 'BIZ_ADDL_STATE']);
  const quoted = (await bookPrice('BIZ_1120S')).cents + (await bookPrice('BIZ_ADDL_STATE')).cents;

  const refused = await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(marian) });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().permission, 'engagements.read', 'the bookkeeper cannot read the return, so cannot read its range');

  const preparer = await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(ana) });
  assert.equal(preparer.statusCode, 200, preparer.body);
  assert.equal((preparer.json() as { quoted_range: { max_cents: number } }).quoted_range.max_cents, quoted);
  const ceo = await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(brian) });
  assert.equal(ceo.statusCode, 200, ceo.body);
  assert.equal((ceo.json() as { quoted_range: { max_cents: number } }).quoted_range.max_cents, quoted, 'the CEO by wildcard');
});
