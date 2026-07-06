// M12 "Prove it": golden tests — every expected number below derives from the
// seeded Pricing Seed Data (cents) + the 15% one-time estimate band. If a
// seed price changes, these tests are SUPPOSED to break.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function quote(items: Array<{ code: string; qty?: number }>, language?: 'en' | 'es') {
  const res = await app.inject({
    method: 'POST', url: '/pricing/quote', headers: auth(ana),
    payload: { items, ...(language ? { language } : {}) },
  });
  return res;
}

before(async () => {
  config = await createTestConfig('price');
  app = buildServer(config);
  await app.ready();
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email: 'ana-price@example.test', name: 'Synthetic Preparer', role: 'tax_preparer',
    password: 'preparer-password-123', totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: staff.email, password: staff.password, totp: code },
  });
  ana = { ...staff, token: login.json().token as string };
});

after(async () => {
  await app.close();
});

test('golden: MFJ + Sch C + additional state = $530 floor, $609.50 banded top', async () => {
  const res = await quote([
    { code: 'IND_BASE_MFJ' },
    { code: 'IND_SCH_C' },
    { code: 'IND_ADDL_STATE' },
  ]);
  assert.equal(res.statusCode, 200, res.body);
  const q = res.json();
  // 20000 + 18000 + 15000 = 53000; max widened 15% → 60950.
  assert.deepEqual(q.revenue.one_time, { minCents: 53000, maxCents: 60950 });
  assert.equal(q.bandPercent, 15);
  assert.equal(q.priceBookVersionNumber, 1);
  assert.equal(q.needsConfirmation, false);
});

test('golden: range-priced item (CPA letters $250–500) spreads before the band', async () => {
  const res = await quote([{ code: 'IND_CPA_LETTER' }]);
  const q = res.json();
  // min 25000; max 50000 × 1.15 = 57500. Flagged for Brian.
  assert.deepEqual(q.revenue.one_time, { minCents: 25000, maxCents: 57500 });
  assert.equal(q.needsConfirmation, true);
});

test('golden: quantities multiply (3 rental properties = $540 floor)', async () => {
  const res = await quote([{ code: 'IND_SCH_E_RENTAL', qty: 3 }]);
  const q = res.json();
  // 18000 × 3 = 54000; banded max 62100.
  assert.deepEqual(q.revenue.one_time, { minCents: 54000, maxCents: 62100 });
});

test('golden: QBO + payroll setup bundle bills as one $250', async () => {
  const res = await quote([{ code: 'SETUP_QBO' }, { code: 'SETUP_PAYROLL' }]);
  const q = res.json();
  assert.equal(q.adjustments.length, 1);
  assert.equal(q.adjustments[0].ruleCode, 'BUNDLE_QBO_PAYROLL_SETUP');
  assert.equal(q.adjustments[0].deltaCents, -25000); // 50000 → 25000
  assert.deepEqual(q.revenue.one_time, { minCents: 25000, maxCents: 28750 });
});

test('golden: monthly package makes ST-1 filings and forecasting free; recurring stays exact', async () => {
  const res = await quote([
    { code: 'ACCT_MONTHLY' },
    { code: 'SALES_TAX_ST1_FILING', qty: 3 },
    { code: 'SPEC_FORECASTING_BUDGETING' },
  ]);
  const q = res.json();
  const st1 = q.lines.find((l: { code: string }) => l.code === 'SALES_TAX_ST1_FILING');
  assert.equal(st1.freeVia, 'FREE_ST1_WITH_MONTHLY');
  assert.equal(st1.minCents, 0);
  const forecast = q.lines.find((l: { code: string }) => l.code === 'SPEC_FORECASTING_BUDGETING');
  assert.equal(forecast.freeVia, 'FREE_FORECAST_WITH_MONTHLY');
  // Monthly revenue is contractual — NO band: exactly $250/mo.
  assert.deepEqual(q.revenue.monthly, { minCents: 25000, maxCents: 25000 });
  assert.deepEqual(q.revenue.one_time, { minCents: 0, maxCents: 0 });
});

test('golden: software pass-through shows on the quote but never in revenue', async () => {
  const res = await quote([
    { code: 'ACCT_MONTHLY' },
    { code: 'PASS_QBO' },
    { code: 'PASS_QBO_PAYROLL' },
  ]);
  const q = res.json();
  assert.equal(q.passThrough.monthly, 9000); // ~$40 + ~$50 software cost
  assert.deepEqual(q.revenue.monthly, { minCents: 25000, maxCents: 25000 });
});

test('spanish quotes carry spanish line names', async () => {
  const res = await quote([{ code: 'IND_BASE_MFJ' }], 'es');
  const line = res.json().lines[0];
  assert.match(line.name, /Casados/);
});

test('unknown item codes are refused by name', async () => {
  const res = await quote([{ code: 'NOT_A_REAL_ITEM' }]);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'unknown_price_items');
  assert.match(res.json().message, /NOT_A_REAL_ITEM/);
});

test('quote-onto-engagement locks the range, pins the version, satisfies the estimate gate', async () => {
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, soto_status)
     VALUES ('Synthetic', 'Quoted', 'quoted@example.test', 'active') RETURNING id`
  );
  const created = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { contactId: contact.rows[0]!.id, taxYear: 2025, returnType: '1040' },
  });
  const teId = created.json().id as string;

  const res = await app.inject({
    method: 'POST', url: `/tax-engagements/${teId}/quote`, headers: auth(ana),
    payload: { items: [{ code: 'IND_BASE_SINGLE' }, { code: 'IND_F8995' }] },
  });
  assert.equal(res.statusCode, 200, res.body);
  const q = res.json().quote;
  // 15000 + 7500 = 22500; banded max 25875.
  assert.deepEqual(q.revenue.one_time, { minCents: 22500, maxCents: 25875 });

  const row = await app.db.query(
    `SELECT te.estimated_fee_min_cents, te.estimated_fee_max_cents, te.estimate_locked_at,
            e.price_book_version_id
     FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id
     WHERE te.id = $1`,
    [teId]
  );
  assert.equal(row.rows[0].estimated_fee_min_cents, 22500);
  assert.equal(row.rows[0].estimated_fee_max_cents, 25875);
  assert.ok(row.rows[0].estimate_locked_at, 'estimate gate satisfied (automation 8)');
  assert.equal(row.rows[0].price_book_version_id, q.priceBookVersionId, 'version pinned at estimate time');

  const audit = await app.db.query(
    `SELECT details FROM audit_log
     WHERE action = 'tax_engagement.estimate_locked' AND object_id = $1
     ORDER BY occurred_at DESC LIMIT 1`,
    [teId]
  );
  assert.equal(audit.rows[0].details.price_book_version, 1);
  assert.equal(audit.rows[0].details.items.length, 2, 'full line detail in the audit trail');
});
