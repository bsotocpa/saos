// DECISION 2 (2026-09-09, Brian's ruling): a return quoted today is for the prior calendar
// year unless the interview names a year, and that year is SHOWN — in the builder (the
// catalog carries defaultTaxYear), on the quote the client reads (periods), and in the
// engagement's title ("Tax 2025 — …"). One test asserts all three. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createQuote, sendQuote, acceptQuote } from '../src/modules/pricing/quotes.ts';
import { defaultTaxYear } from '../src/modules/engagements/period.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
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

/** A quotable TAX item from the live price book. */
async function taxItem(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string }>(
    `SELECT pbi.item_code FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.service_line IN ('individual_tax', 'business_tax') AND pbi.is_active AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.sort_order LIMIT 1`);
  assert.ok(rows[0], 'the price book has a quotable tax item');
  return rows[0]!.item_code;
}

before(async () => {
  config = await createTestConfig('taxyear');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  ceo = await staffWithToken('ceo-taxyear@example.test', 'ceo');
});

after(async () => {
  await app.close();
});

test('the default tax year is the prior calendar year, and it is shown in the builder, on the quote, and in the engagement title', async () => {
  const year = String(defaultTaxYear(todayChicago()));
  assert.equal(Number(year), Number(todayChicago().slice(0, 4)) - 1, 'prior calendar year');

  // 1. The builder: the catalog carries the year the server will use.
  const catalog = await app.inject({ method: 'GET', url: '/quotes/catalog', headers: auth(ceo) });
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.equal(String(catalog.json().defaultTaxYear), year, 'the builder reads the year from the server');

  // 2. The quote — staff view and the client's public view — names the period per line.
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Taxyear', email: 'taxyear@example.test' });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const q = await createQuote(app, { contactId: c.id, lines: [{ itemCode: await taxItem() }] }, actor());
  const staffView = await app.inject({ method: 'GET', url: `/quotes/${q.id}`, headers: auth(ceo) });
  assert.equal(staffView.statusCode, 200, staffView.body);
  assert.deepEqual(staffView.json().periods, [{ serviceLine: 'tax', periodKey: year }]);

  const sent = await sendQuote(app, q.id, actor());
  const token = sent.url.split('/').pop()!;
  const publicView = await app.inject({ method: 'GET', url: `/public/quote/${token}` });
  assert.equal(publicView.statusCode, 200, publicView.body);
  assert.deepEqual(publicView.json().periods, [{ serviceLine: 'tax', periodKey: year }], 'the client reads the same year');

  // 3. The engagement title carries the year.
  const acc = await acceptQuote(app, token, {});
  const eng = await app.db.query<{ title: string; period_key: string }>(`SELECT title, period_key FROM engagements WHERE id = $1`, [acc.engagementId]);
  assert.equal(eng.rows[0]!.period_key, year);
  assert.match(eng.rows[0]!.title, new RegExp(`^Tax ${year} — `), eng.rows[0]!.title);
});

test('an interview that names the year wins over the default', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Namedyear', email: 'namedyear@example.test' });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const q = await createQuote(app, { contactId: c.id, lines: [{ itemCode: await taxItem() }], interviewAnswers: { tax_year: 2023 } }, actor());
  const view = await app.inject({ method: 'GET', url: `/quotes/${q.id}`, headers: auth(ceo) });
  assert.deepEqual(view.json().periods, [{ serviceLine: 'tax', periodKey: '2023' }]);
  const sent = await sendQuote(app, q.id, actor());
  const acc = await acceptQuote(app, sent.url.split('/').pop()!, {});
  const eng = await app.db.query<{ title: string }>(`SELECT title FROM engagements WHERE id = $1`, [acc.engagementId]);
  assert.match(eng.rows[0]!.title, /^Tax 2023 — /);
});
