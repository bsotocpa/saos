// "Prove it": Brian's pricing rulings, 2026-08-09.
//
//  1. Weekly accounting $300/week all-in = $200 prep + $100 session.
//  2. Session component $100; any prep × session combination derives as
//     prep component + (sessions × $100). Existing plans recalibrated so the
//     components sum EXACTLY to today's package totals — no client re-prices.
//  3. Presentation (hard): quotes and invoices always show the bundled total,
//     never a broken-out session fee. Components are derivation-only.
//  4. Verify maintenance mode (monthly prep + semi-annual sessions) and the
//     utilization report's entitlement math.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createInvoice } from '../src/modules/billing/service.ts';
import { runReport } from '../src/modules/reports/service.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

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

async function recurringEngagement(contactId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/engagements', headers: auth(brian),
    payload: { contactId, serviceLine: 'bookkeeping', status: 'active', title: 'Synthetic recurring' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

async function configure(engId: string, prepCadence: string, sessionCadence: string) {
  return app.inject({
    method: 'POST', url: `/engagements/${engId}/configure`, headers: auth(brian),
    payload: { prepCadence, sessionCadence },
  });
}

before(async () => {
  config = await createTestConfig('pricingrulings');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-pr@example.test', 'ceo');
});

after(async () => {
  await app.close();
});

test('the two price layers agree to the cent: bundled = prep + one session', async () => {
  // The anti-drift guard. Edit a package total without its component (or the
  // reverse) and this fails, rather than a client seeing one number on a quote
  // and a different one on an invoice.
  const { rows } = await app.db.query<{ item_code: string; amount_cents: number }>(
    `SELECT i.item_code, i.amount_cents FROM price_book_items i
     JOIN price_book_versions v ON v.id = i.version_id
     WHERE v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
       AND i.item_code = ANY($1)`,
    [[
      'ACCT_WEEKLY', 'ACCT_MONTHLY', 'ACCT_QUARTERLY', 'ACCT_SEMI_ANNUAL',
      'ACCT_PREP_WEEKLY', 'ACCT_PREP_MONTHLY', 'ACCT_PREP_QUARTERLY', 'ACCT_PREP_SEMI_ANNUAL',
      'CPA_SESSION',
    ]]
  );
  const cents = Object.fromEntries(rows.map((r) => [r.item_code, r.amount_cents]));
  const session = cents.CPA_SESSION!;

  for (const cadence of ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMI_ANNUAL'] as const) {
    assert.equal(
      cents[`ACCT_${cadence}`],
      cents[`ACCT_PREP_${cadence}`]! + session,
      `ACCT_${cadence} must equal ACCT_PREP_${cadence} + CPA_SESSION`
    );
  }

  // The ruling's actual figures, so a coordinated change to all layers is caught.
  assert.equal(cents.ACCT_WEEKLY, 30000);
  assert.equal(cents.ACCT_PREP_WEEKLY, 20000);
  assert.equal(cents.ACCT_MONTHLY, 25000);
  assert.equal(cents.ACCT_PREP_MONTHLY, 15000);
  assert.equal(cents.ACCT_QUARTERLY, 60000);
  assert.equal(cents.ACCT_PREP_QUARTERLY, 50000);
  assert.equal(cents.ACCT_SEMI_ANNUAL, 100000);
  assert.equal(cents.ACCT_PREP_SEMI_ANNUAL, 90000);
  assert.equal(session, 10000);

  // Components are flagged non-quotable; bundled plans are not.
  const flags = await app.db.query<{ item_code: string; display_on_quote: boolean }>(
    `SELECT i.item_code, i.display_on_quote FROM price_book_items i
     JOIN price_book_versions v ON v.id = i.version_id
     WHERE v.effective_to IS NULL AND i.item_code = ANY($1)`,
    [['ACCT_MONTHLY', 'ACCT_PREP_MONTHLY', 'CPA_SESSION']]
  );
  const byCode = Object.fromEntries(flags.rows.map((r) => [r.item_code, r.display_on_quote]));
  assert.equal(byCode.ACCT_MONTHLY, true);
  assert.equal(byCode.ACCT_PREP_MONTHLY, false);
  assert.equal(byCode.CPA_SESSION, false);
});

test('Brian confirmed the semi-annual price, so it no longer awaits confirmation', async () => {
  const { rows } = await app.db.query<{ needs_confirmation: boolean }>(
    `SELECT i.needs_confirmation FROM price_book_items i
     JOIN price_book_versions v ON v.id = i.version_id
     WHERE v.effective_to IS NULL AND i.item_code = 'ACCT_SEMI_ANNUAL'`
  );
  assert.equal(rows[0]!.needs_confirmation, false, '$1,000 all-in was ruled on 2026-08-09');
});

test('RULING 1: weekly is configurable now, and prices at $300/week all-in', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Weekly', email: 'weekly-pr@example.test' });
  const engId = await recurringEngagement(client.id);
  const res = await configure(engId, 'weekly', 'weekly');
  assert.equal(res.statusCode, 200, res.body);
  const cfg = res.json();

  // $200 prep × 52 close periods + 52 sessions × $100 = $15,600/yr.
  assert.equal(cfg.annualCents, 20000 * 52 + 52 * 10000);
  assert.equal(cfg.annualCents, 1560000);
  assert.equal(cfg.clientFacing.amountCents, 30000, '$300/week all-in');
  assert.equal(cfg.clientFacing.unit, 'per_week');
  assert.equal(cfg.clientFacing.fromPackageItem, true);
  // The client-facing label never names a session fee.
  assert.ok(!/\$100|session fee/i.test(cfg.clientFacing.label), cfg.clientFacing.label);
});

test('RULING 2: matched cadences price at today’s totals — no current client re-prices', async () => {
  const expected: Array<[string, number, string]> = [
    ['monthly', 25000, 'per_month'],
    ['quarterly', 60000, 'per_quarter'],
    ['semi_annual', 100000, 'per_6_months'],
  ];
  for (const [cadence, cents, unit] of expected) {
    const client = await makeContact(app.db, {
      firstName: 'Synthetic', lastName: `Match`, email: `match-${cadence}-pr@example.test`,
    });
    const engId = await recurringEngagement(client.id);
    const res = await configure(engId, cadence, cadence);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().clientFacing.amountCents, cents, `${cadence} still prices at its package total`);
    assert.equal(res.json().clientFacing.unit, unit);
  }
});

test('RULING 2: a mismatched combination derives, and is still ONE figure', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Mixed', email: 'mixed-pr@example.test' });
  const engId = await recurringEngagement(client.id);
  // Monthly books, quarterly sessions: $150 × 12 + 4 × $100 = $2,200/yr.
  const res = await configure(engId, 'monthly', 'quarterly');
  assert.equal(res.statusCode, 200, res.body);
  const cfg = res.json();
  assert.equal(cfg.annualCents, 15000 * 12 + 4 * 10000);
  assert.equal(cfg.annualCents, 220000);
  assert.equal(cfg.clientFacing.fromPackageItem, false, 'no package exists for this pairing');
  assert.equal(cfg.clientFacing.amountCents, Math.round(220000 / 12));
  assert.equal(cfg.clientFacing.unit, 'per_month', 'presented in the close-period the client is billed on');
  // Between the two matched plans, as it should be.
  assert.ok(cfg.clientFacing.amountCents < 25000);
});

test('RULING 4: maintenance mode derives monthly prep + semi-annual sessions', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Maint', email: 'maint-pr@example.test' });
  const engId = await recurringEngagement(client.id);
  await configure(engId, 'monthly', 'monthly');

  const maint = await app.inject({
    method: 'POST', url: `/engagements/${engId}/maintenance-mode`, headers: auth(brian),
    payload: { sessionCadence: 'semi_annual' },
  });
  assert.equal(maint.statusCode, 200, maint.body);
  const cfg = maint.json();

  assert.equal(cfg.prepCadence, 'monthly', 'prep cadence held — that is what maintenance mode means');
  assert.equal(cfg.sessionsPerYear, 2);
  // $150 × 12 + 2 × $100 = $2,000/yr → $166.67/mo.
  assert.equal(cfg.annualCents, 15000 * 12 + 2 * 10000);
  assert.equal(cfg.annualCents, 200000);
  assert.equal(cfg.monthlyEquivalentCents, Math.round(200000 / 12));
  assert.equal(cfg.clientFacing.fromPackageItem, false);
  assert.equal(cfg.clientFacing.amountCents, Math.round(200000 / 12));
  assert.equal(cfg.clientFacing.unit, 'per_month');
  assert.ok(cfg.clientFacing.amountCents < 25000, 'cheaper than the full monthly plan');

  // The internal breakdown is for staff, and is not shaped like quote lines, so
  // it cannot be handed to a client-facing renderer by accident.
  assert.equal(cfg.internalBreakdown.prepItemCode, 'ACCT_PREP_MONTHLY');
  assert.equal(cfg.internalBreakdown.sessionItemCode, 'CPA_SESSION');
  assert.equal(cfg.internalBreakdown.sessionsPerYear, 2);
  assert.equal(cfg.internalBreakdown.prepPeriodsPerYear, 12);
  assert.ok(!Array.isArray(cfg.internalBreakdown));
  assert.equal(cfg.lines, undefined, 'no quote-shaped line array is returned at all');

  // The history row carries the derived monthly figure, not a prep-only number.
  const history = await app.db.query<{ monthly_equivalent_cents: number }>(
    `SELECT monthly_equivalent_cents FROM engagement_config_history
     WHERE engagement_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [engId]
  );
  assert.equal(history.rows[0]!.monthly_equivalent_cents, Math.round(200000 / 12));
});

test('RULING 3: a component can never reach a quote, an invoice, or the builder', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'NoSplit', email: 'nosplit-pr@example.test' });

  const quoted = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(brian),
    payload: { contactId: client.id, lines: [{ itemCode: 'CPA_SESSION' }] },
  });
  assert.equal(quoted.statusCode, 400, quoted.body);
  assert.equal(quoted.json().error, 'not_quotable');
  assert.match(quoted.json().message, /one bundled plan price/);

  // A component smuggled in beside legitimate lines still kills the quote.
  const mixed = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(brian),
    payload: { contactId: client.id, lines: [{ itemCode: 'IND_BASE_SINGLE' }, { itemCode: 'ACCT_PREP_MONTHLY' }] },
  });
  assert.equal(mixed.statusCode, 400);
  assert.equal(mixed.json().error, 'not_quotable');
  const noQuote = await app.db.query(`SELECT 1 FROM quotes WHERE contact_id = $1`, [client.id]);
  assert.equal(noQuote.rows.length, 0, 'the refused quote was not partially written');

  // The bundled plan IS quotable — that is the entire point of the two layers.
  const ok = await app.inject({
    method: 'POST', url: '/quotes', headers: auth(brian),
    payload: { contactId: client.id, lines: [{ itemCode: 'ACCT_MONTHLY' }] },
  });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().totalCents, 25000);

  // Invoices refuse components too.
  await assert.rejects(
    createInvoice(app, { type: 'system', label: 'test' }, { contactId: client.id, lines: [{ code: 'CPA_SESSION' }] }),
    (err: Error & { code?: string }) => err.code === 'not_invoiceable',
    'an invoice must never itemize the session component'
  );

  // And the builder catalog does not offer components to staff at all.
  const catalog = await app.inject({ method: 'GET', url: '/quotes/catalog', headers: auth(brian) });
  const codes = catalog.json().items.map((i: { item_code: string }) => i.item_code);
  assert.ok(codes.includes('ACCT_MONTHLY'));
  assert.ok(codes.includes('ACCT_WEEKLY'));
  for (const c of ['CPA_SESSION', 'ACCT_PREP_MONTHLY', 'ACCT_PREP_WEEKLY', 'LATE_FEE_MONTHLY']) {
    assert.ok(!codes.includes(c), `${c} must not be offered in the quote builder`);
  }
});

test('RULING 4: utilization entitlement reads sessions_per_year as configured', async () => {
  const client = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Entitled', email: 'entitled-pr@example.test' });
  const engId = await recurringEngagement(client.id);
  // Weekly books, monthly sessions → 12/year entitlement.
  await configure(engId, 'weekly', 'monthly');
  const stored = await app.db.query<{ sessions_per_year: number }>(
    `SELECT sessions_per_year FROM engagements WHERE id = $1`, [engId]
  );
  assert.equal(stored.rows[0]!.sessions_per_year, 12);

  await app.db.query(
    `INSERT INTO client_sessions (contact_id, starts_at, status) VALUES
       ($1, now() - interval '100 days', 'completed'),
       ($1, now() - interval '60 days', 'completed'),
       ($1, now() - interval '20 days', 'completed')`,
    [client.id]
  );
  const result = await runReport(app, 'session_utilization', { from: '2020-01-01', to: '2030-12-31' });
  const row = result.rows.find((r) => String(r.client).includes('Entitled'))!;
  assert.equal(row.entitled_per_year, '12', 'entitlement comes from the session dial, not a guess');
  assert.equal(row.held, 3);
  assert.equal(row.utilization, '25%');
});

test('the builder catalog carries deposit_cents, and it is the number acceptance will charge', async () => {
  /*
   * 2026-09-09. Brian, building a rehearsal quote, saw a "Deposit item" dropdown whose only
   * option was "— no deposit —", over a quote that carried $200. The dropdown was from the
   * one-deposit-item model retired in price book v4; deposits are per line now and the quote's
   * deposit is their sum (summedLineDeposits). The catalog did not return deposit_cents, so the
   * builder had nothing true to show and kept showing the dead control instead.
   *
   * Two assertions, and the second is the one that matters: the field must be PRESENT on every
   * item (null is an answer; absent is a missing wire), and for a line that carries one, the
   * builder's number must equal the server's. A builder that shows a different deposit from the
   * one the client is asked for is a new lie replacing the old one.
   */
  const catalog = await app.inject({ method: 'GET', url: '/quotes/catalog', headers: auth(brian) });
  assert.equal(catalog.statusCode, 200, catalog.body);
  const items = catalog.json().items as Array<{ item_code: string; deposit_cents: number | null }>;
  assert.ok(items.length > 0, 'the catalog in force has items');
  for (const i of items) {
    assert.ok('deposit_cents' in i, `${i.item_code}: deposit_cents must be present (null is fine, absent is not)`);
  }
  const withDeposit = items.filter((i) => typeof i.deposit_cents === 'number' && i.deposit_cents > 0);
  assert.ok(
    withDeposit.length > 0,
    'at least one quotable line carries a deposit — otherwise no client can ever be asked to pay one, and nothing would say so'
  );

  const { createQuote, resolveDeposit } = await import('../src/modules/pricing/quotes.ts');
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Depositline', email: 'depositline-pr@example.test' });
  const line = withDeposit[0]!;
  const quote = await createQuote(
    app,
    { contactId: c.id, lines: [{ itemCode: line.item_code }] },
    { id: brian.id, email: brian.email, fullName: 'Synthetic ceo', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' }
  );
  const resolved = await resolveDeposit(app, null, null, quote.id);
  assert.equal(
    resolved.standardCents,
    line.deposit_cents,
    'what the builder shows from the catalog is exactly what acceptance resolves for the quote'
  );
});
