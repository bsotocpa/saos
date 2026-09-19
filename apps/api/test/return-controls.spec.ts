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
 *  · a bookkeeper gets 403 from all three routes.
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, signed8879OnFile, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { TAX_STAGES, legalNextStages } from '../src/modules/tax/pipeline.ts';
import { currentPriceBookVersion } from '../src/modules/pricing/service.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };
let brian: TestStaff & { token: string };
let marian: TestStaff & { token: string };
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
});
after(async () => { await app.close(); });

/**
 * A quoted 1120S at a given stage: the engagement carries the scope snapshot an accepted quote
 * leaves (#47) — the BIZ_1120S line under the price book in force — with the letter signed so the
 * gates past 'scheduled' are open, and Ana assigned.
 */
async function quotedReturn(last: string, stage: string, opts: { lockEstimate?: boolean } = {}): Promise<{ id: string; contactId: string; engagementId: string }> {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: last, email: `${last.toLowerCase()}-controls@example.test` });
  const version = await currentPriceBookVersion(app.db);
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status, price_book_version_id) VALUES ($1, 'tax', '2025 1120S', 'active', $2) RETURNING id`,
    [c.id, version.id]
  );
  await app.db.query(
    `INSERT INTO engagement_scope_items (engagement_id, price_book_version_id, item_code, description_en, quantity, unit_cents, line_cents)
     SELECT $1, $2, item_code, name_en, 1, amount_cents, amount_cents FROM price_book_items WHERE version_id = $2 AND item_code = 'BIZ_1120S'`,
    [eng.rows[0]!.id, version.id]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, stage, preparer_id, engagement_letter_signed_at, estimate_locked_at)
     VALUES ($1, 2025, '1120s', 'business', $2::tax_stage, $3, now(), CASE WHEN $4 THEN now() ELSE NULL END) RETURNING id`,
    [eng.rows[0]!.id, stage, ana.id, Boolean(opts.lockEstimate)]
  );
  return { id: te.rows[0]!.id, contactId: c.id, engagementId: eng.rows[0]!.id };
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
    assigned_preparer: { id: string; name: string } | null; staff_options: Array<{ id: string; name: string }>;
  };
  // The accepted quote's line for this return, priced from the current book: a flat item is a range of one number.
  assert.deepEqual(j.quoted_range, { min_cents: price.cents, max_cents: price.cents, price_book_version: price.version });
  assert.deepEqual(j.legal_next_stages, ['filed']);
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

test('above a locked estimate the one reason serves both rules: scope creep is flagged under "other" with the reason as its description', async () => {
  const te = await quotedReturn('Creep', 'ready_to_file');
  await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/estimate`, headers: auth(ana), payload: { minCents: 60000, maxCents: 80000 } });
  const bare = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana), payload: { finalFeeCents: 95000 } });
  assert.equal(bare.statusCode, 409);
  assert.equal(bare.json().error, 'scope_creep_reason_required');
  const ok = await app.inject({
    method: 'POST', url: `/tax-engagements/${te.id}/final-fee`, headers: auth(ana),
    payload: { finalFeeCents: 95000, reason: 'Late documents arrived after the estimate and a prior-year cleanup was needed first.' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().scopeCreepFlag, true);
  const row = await app.db.query<{ scope_creep_reason: string; scope_creep_description: string }>(
    `SELECT scope_creep_reason::text AS scope_creep_reason, scope_creep_description FROM tax_engagements WHERE id = $1`, [te.id]);
  assert.equal(row.rows[0]!.scope_creep_reason, 'other');
  assert.match(row.rows[0]!.scope_creep_description, /Late documents/);
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
  assert.deepEqual(filed.json(), { status: 'ok', from: 'ready_to_file', to: 'filed' });

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
