// "Prove it": deposit flexibility (Brian's ruling, 2026-08-09).
//
// The deposit on any quote is overridable to any amount >= 0 — reduced or fully
// waived — by staff holding `deposits.override`, seeded to Brian ONLY.
//
// The interesting part is that "Brian only" was previously inexpressible: both
// the ceo and ed_coo roles hold '*'. So `deposits.override` is an EXPLICIT-ONLY
// permission that the wildcard does not confer, and the first test below is the
// one that matters — Jackson holds '*' and still gets a 403.
//
// Also under test: no unexplained override (schema CHECK), the treatment is
// DERIVED by comparing to the price book rather than asserted by the caller, the
// engagement is stamped for A/R, and a waived deposit issues no invoice at all.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { EXPLICIT_ONLY_PERMISSIONS } from '../src/plugins/auth.ts';
import { runReport } from '../src/modules/reports/service.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let jackson: TestStaff & { token: string };
let ana: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const DEPOSIT_CODE = 'DEPOSIT_1040';

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

/** A draft quote with the standard 1040 deposit attached. */
async function quoteWithDeposit(label: string): Promise<{ quoteId: string; contactId: string }> {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: label, email: `${label.toLowerCase()}-dep@example.test`,
  });
  const res = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(brian),
    payload: { contactId: c.id, lines: [{ itemCode: 'IND_BASE_MFJ' }], depositItemCode: DEPOSIT_CODE },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { quoteId: res.json().id as string, contactId: c.id };
}

async function standardDeposit(): Promise<number> {
  const { rows } = await app.db.query<{ amount_cents: number }>(
    `SELECT i.amount_cents FROM price_book_items i JOIN price_book_versions v ON v.id = i.version_id
     WHERE v.effective_to IS NULL AND i.item_code = $1`,
    [DEPOSIT_CODE]
  );
  return rows[0]!.amount_cents;
}

before(async () => {
  config = await createTestConfig('depositoverride');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-dep@example.test', 'ceo');
  jackson = await staffWithToken('jackson-dep@example.test', 'ed_coo');
  ana = await staffWithToken('ana-dep@example.test', 'tax_preparer');
});

after(async () => {
  await app.close();
});

test('deposits.override is Brian ONLY — a wildcard role does not inherit it', async () => {
  assert.ok(EXPLICIT_ONLY_PERMISSIONS.has('deposits.override'));

  // Jackson genuinely holds '*' — that is the premise of the test.
  const jacksonMe = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(jackson) });
  assert.ok(jacksonMe.json().permissions.includes('*'), 'ed_coo holds the wildcard');
  assert.ok(
    !jacksonMe.json().permissions.includes('deposits.override'),
    'and is NOT granted the deposit override by name'
  );

  const brianMe = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(brian) });
  assert.ok(brianMe.json().permissions.includes('deposits.override'), 'the CEO role is granted it explicitly');

  const { quoteId } = await quoteWithDeposit('Rbac');
  const body = { amountCents: 0, reason: 'Long-standing client, waiving as a goodwill gesture.' };

  // Jackson: wildcard is not enough.
  const jacksonTry = await app.inject({
    method: 'POST', url: `/quotes/${quoteId}/deposit-override`, headers: auth(jackson), payload: body,
  });
  assert.equal(jacksonTry.statusCode, 403, jacksonTry.body);
  assert.equal(jacksonTry.json().permission, 'deposits.override');

  // Ana: no wildcard, no grant.
  const anaTry = await app.inject({
    method: 'POST', url: `/quotes/${quoteId}/deposit-override`, headers: auth(ana), payload: body,
  });
  assert.equal(anaTry.statusCode, 403);

  // Brian: allowed.
  const brianTry = await app.inject({
    method: 'POST', url: `/quotes/${quoteId}/deposit-override`, headers: auth(brian), payload: body,
  });
  assert.equal(brianTry.statusCode, 200, brianTry.body);

  // Every other permission still works by wildcard — the carve-out is narrow.
  const stillFine = await app.inject({ method: 'GET', url: '/pipeline', headers: auth(jackson) });
  assert.equal(stillFine.statusCode, 200, 'the wildcard is unchanged for everything else');
});

test('an override cannot exist without a reason and an approver', async () => {
  const { quoteId } = await quoteWithDeposit('Reasoned');

  // Too short to be a record.
  const thin = await app.inject({
    method: 'POST', url: `/quotes/${quoteId}/deposit-override`, headers: auth(brian),
    payload: { amountCents: 5000, reason: 'because' },
  });
  assert.equal(thin.statusCode, 400, thin.body);

  // And the database refuses a bare amount even by direct SQL — the four columns
  // are all-or-nothing, so "who waived this and why" is always answerable.
  await assert.rejects(
    app.db.query(`UPDATE quotes SET deposit_override_cents = 0 WHERE id = $1`, [quoteId]),
    /quotes_deposit_override_complete/,
    'the completeness rule is a CHECK, not just handler validation'
  );

  const ok = await app.inject({
    method: 'POST', url: `/quotes/${quoteId}/deposit-override`, headers: auth(brian),
    payload: { amountCents: 5000, reason: 'Cash-flow tight this quarter; agreed a smaller deposit.' },
  });
  assert.equal(ok.statusCode, 200, ok.body);

  const row = await app.db.query<{
    deposit_override_cents: number; deposit_override_reason: string;
    deposit_override_by_staff_id: string; deposit_override_at: Date;
  }>(
    `SELECT deposit_override_cents, deposit_override_reason, deposit_override_by_staff_id, deposit_override_at
     FROM quotes WHERE id = $1`,
    [quoteId]
  );
  assert.equal(row.rows[0]!.deposit_override_cents, 5000);
  assert.match(row.rows[0]!.deposit_override_reason, /Cash-flow tight/);
  assert.equal(row.rows[0]!.deposit_override_by_staff_id, brian.id);
  assert.ok(row.rows[0]!.deposit_override_at);

  // Amount, approver, and reason are all in the audit trail too.
  assert.ok((await auditRows(app.db, 'quote.deposit_overridden')) >= 1);
  const audit = await app.db.query<{ details: { override_cents: number; approver: string; reason: string; treatment: string } }>(
    `SELECT details FROM audit_log WHERE action = 'quote.deposit_overridden' AND object_id = $1`, [quoteId]
  );
  assert.equal(audit.rows[0]!.details.override_cents, 5000);
  assert.equal(audit.rows[0]!.details.approver, brian.email);
  assert.equal(audit.rows[0]!.details.treatment, 'reduced');
  assert.match(audit.rows[0]!.details.reason, /Cash-flow tight/);
});

test('treatment is DERIVED from the price book, not asserted by the caller', async () => {
  const standard = await standardDeposit();

  // Equal to standard: not an exception, so A/R is not asked to chase it.
  const same = await quoteWithDeposit('Same');
  const sameRes = await app.inject({
    method: 'POST', url: `/quotes/${same.quoteId}/deposit-override`, headers: auth(brian),
    payload: { amountCents: standard, reason: 'Re-confirming the standard deposit explicitly.' },
  });
  assert.equal(sameRes.json().treatment, 'standard');
  assert.equal(sameRes.json().isOverridden, false);

  // Below standard → reduced. Zero → waived.
  const less = await quoteWithDeposit('Less');
  const lessRes = await app.inject({
    method: 'POST', url: `/quotes/${less.quoteId}/deposit-override`, headers: auth(brian),
    payload: { amountCents: standard - 1, reason: 'Split the difference with the client on the deposit.' },
  });
  assert.equal(lessRes.json().treatment, 'reduced');

  const zero = await quoteWithDeposit('Zero');
  const zeroRes = await app.inject({
    method: 'POST', url: `/quotes/${zero.quoteId}/deposit-override`, headers: auth(brian),
    payload: { amountCents: 0, reason: 'Waived entirely — referral partner, first engagement.' },
  });
  assert.equal(zeroRes.json().treatment, 'waived');
  assert.equal(zeroRes.json().dueCents ?? zeroRes.json().chargeCents, 0);

  // Negative is refused by the schema on the way in.
  const negative = await app.inject({
    method: 'POST', url: `/quotes/${zero.quoteId}/deposit-override`, headers: auth(brian),
    payload: { amountCents: -100, reason: 'This should never be accepted anywhere.' },
  });
  assert.equal(negative.statusCode, 400);

  // Reverting to the price book clears all four columns together.
  const cleared = await app.inject({
    method: 'POST', url: `/quotes/${less.quoteId}/deposit-override`, headers: auth(brian),
    payload: { amountCents: null, reason: 'Client changed their mind; standard deposit applies.' },
  });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().treatment, 'standard');
  const back = await app.db.query<{ c: number | null; r: string | null; s: string | null; a: Date | null }>(
    `SELECT deposit_override_cents AS c, deposit_override_reason AS r,
            deposit_override_by_staff_id AS s, deposit_override_at AS a
     FROM quotes WHERE id = $1`,
    [less.quoteId]
  );
  assert.deepEqual(
    [back.rows[0]!.c, back.rows[0]!.r, back.rows[0]!.s, back.rows[0]!.a],
    [null, null, null, null]
  );
});

test('a WAIVED deposit issues no invoice, and stamps the engagement for A/R', async () => {
  const { quoteId, contactId } = await quoteWithDeposit('Waived');
  const standard = await standardDeposit();
  await app.inject({
    method: 'POST', url: `/quotes/${quoteId}/deposit-override`, headers: auth(brian),
    payload: { amountCents: 0, reason: 'Waived — long-standing client, cash flow is genuinely tight.' },
  });
  const { token } = (await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(brian) })).json();

  // The CLIENT is told the deposit was waived, not left to infer it from silence.
  const view = await app.inject({ method: 'GET', url: `/public/quote/${token}` });
  assert.equal(view.json().deposit.waived, true);
  assert.equal(view.json().deposit.dueCents, 0);
  assert.equal(view.json().deposit.standardCents, standard);
  assert.ok(!JSON.stringify(view.json()).includes('cash flow is genuinely tight'), 'the internal reason never ships');

  const accepted = await app.inject({ method: 'POST', url: `/public/quote/${token}/accept`, payload: {} });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().depositInvoiceId, null, 'a waived deposit issues NO invoice');
  const invoices = await app.db.query(`SELECT 1 FROM invoices WHERE contact_id = $1`, [contactId]);
  assert.equal(invoices.rows.length, 0);

  const eng = await app.db.query<{
    deposit_treatment: string; deposit_standard_cents: number; deposit_charged_cents: number;
    deposit_override_reason: string; deposit_override_by_staff_id: string;
  }>(
    `SELECT deposit_treatment::text, deposit_standard_cents, deposit_charged_cents,
            deposit_override_reason, deposit_override_by_staff_id
     FROM engagements WHERE id = $1`,
    [accepted.json().engagementId]
  );
  const e = eng.rows[0]!;
  assert.equal(e.deposit_treatment, 'waived');
  assert.equal(e.deposit_standard_cents, standard, 'the gap is what A/R wants, so the standard is kept');
  assert.equal(e.deposit_charged_cents, 0);
  assert.match(e.deposit_override_reason, /cash flow/i);
  assert.equal(e.deposit_override_by_staff_id, brian.id);
});

test('a REDUCED deposit invoices the reduced amount, not the price-book figure', async () => {
  const { quoteId, contactId } = await quoteWithDeposit('Reduced');
  const standard = await standardDeposit();
  const reduced = Math.round(standard / 2);
  await app.inject({
    method: 'POST', url: `/quotes/${quoteId}/deposit-override`, headers: auth(brian),
    payload: { amountCents: reduced, reason: 'Halved the deposit to get the engagement started this month.' },
  });
  const { token } = (await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(brian) })).json();
  const accepted = await app.inject({ method: 'POST', url: `/public/quote/${token}/accept`, payload: {} });
  assert.equal(accepted.statusCode, 200, accepted.body);

  const inv = await app.db.query<{ total_cents: number }>(
    `SELECT total_cents FROM invoices WHERE id = $1`, [accepted.json().depositInvoiceId]
  );
  assert.equal(inv.rows[0]!.total_cents, reduced, 'the reduced amount, NOT the book deposit');
  assert.notEqual(inv.rows[0]!.total_cents, standard);

  // The line is a custom-amount line: quoting the deposit item code would have
  // re-charged the standard figure.
  const line = await app.db.query<{ item_code: string | null; unit_cents: number }>(
    `SELECT item_code, unit_cents FROM invoice_line_items WHERE invoice_id = $1`,
    [accepted.json().depositInvoiceId]
  );
  assert.equal(line.rows[0]!.item_code, null);
  assert.equal(line.rows[0]!.unit_cents, reduced);

  const eng = await app.db.query<{ deposit_treatment: string; deposit_charged_cents: number }>(
    `SELECT deposit_treatment::text, deposit_charged_cents FROM engagements WHERE id = $1`,
    [accepted.json().engagementId]
  );
  assert.equal(eng.rows[0]!.deposit_treatment, 'reduced');
  assert.equal(eng.rows[0]!.deposit_charged_cents, reduced);

  // A/R aging can now isolate these engagements — the whole point of the flag.
  await app.db.query(`UPDATE invoices SET sent_at = now() - interval '40 days' WHERE contact_id = $1`, [contactId]);
  const report = await runReport(app, 'ar_aging', { from: '2020-01-01', to: '2030-12-31' });
  const total = report.rows.reduce((n, r) => n + (r.waived_deposit_invoices as number), 0);
  assert.ok(total >= 1, 'the reduced-deposit invoice shows in the A/R non-standard column');
});

test('the standard deposit is still the default, and an accepted quote cannot be re-cut', async () => {
  const { quoteId } = await quoteWithDeposit('Default');
  const standard = await standardDeposit();
  const { token } = (await app.inject({ method: 'POST', url: `/quotes/${quoteId}/send`, headers: auth(brian) })).json();

  const view = await app.inject({ method: 'GET', url: `/public/quote/${token}` });
  assert.equal(view.json().deposit.dueCents, standard, 'untouched quotes charge the price-book deposit');
  assert.equal(view.json().deposit.treatment, 'standard');
  assert.equal(view.json().deposit.waived, false);

  const accepted = await app.inject({ method: 'POST', url: `/public/quote/${token}/accept`, payload: {} });
  const inv = await app.db.query<{ total_cents: number }>(
    `SELECT total_cents FROM invoices WHERE id = $1`, [accepted.json().depositInvoiceId]
  );
  assert.equal(inv.rows[0]!.total_cents, standard);
  const eng = await app.db.query<{ deposit_treatment: string; deposit_override_reason: string | null }>(
    `SELECT deposit_treatment::text, deposit_override_reason FROM engagements WHERE id = $1`,
    [accepted.json().engagementId]
  );
  assert.equal(eng.rows[0]!.deposit_treatment, 'standard');
  assert.equal(eng.rows[0]!.deposit_override_reason, null, 'no reason needed when nothing was overridden');

  // Once accepted, the deposit invoice exists — changing the figure behind it
  // would put the books and the client's copy out of step.
  const late = await app.inject({
    method: 'POST', url: `/quotes/${quoteId}/deposit-override`, headers: auth(brian),
    payload: { amountCents: 0, reason: 'Trying to waive after the fact, which must be refused.' },
  });
  assert.equal(late.statusCode, 409, late.body);
  assert.equal(late.json().error, 'quote_closed');
});

test('an override cannot invent a deposit where the quote has none', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Nodeposit', email: 'nodep-dep@example.test' });
  const created = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(brian),
    payload: { contactId: c.id, lines: [{ itemCode: 'IND_BASE_SINGLE' }] },
  });
  const res = await app.inject({
    method: 'POST', url: `/quotes/${created.json().id}/deposit-override`, headers: auth(brian),
    payload: { amountCents: 2500, reason: 'Attempting to add a deposit that has no price-book item.' },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, 'no_deposit_on_quote');
});
