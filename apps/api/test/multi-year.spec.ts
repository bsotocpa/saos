// R89 (Brian, 2026-09-29): MULTI-YEAR ENGAGEMENTS.
//
// Answer A: one engagement, one return per year. tax_engagements is keyed by (engagement_id, tax_year);
// a quote's return lines each carry their year; acceptance opens one return per year, each with its own
// stage and checklist, under one engagement whose title lists the years. Answer B: the server adds
// PRIOR_YEAR_SURCHARGE once for every quoted year more than two back, single-year and multi-year alike,
// from the book, never typed. The deposit rule applies once per year: one invoice, one line per year.
// Every reader that assumed one return per engagement reads per return. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { acceptQuote, createQuote, sendQuote } from '../src/modules/pricing/quotes.ts';
import { quotedRangeFor } from '../src/modules/tax/routes.ts';
import { defaultTaxYear } from '../src/modules/engagements/period.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
const auth = () => ({ authorization: `Bearer ${ceo.token}` });
const actor = () => ({ id: ceo.id, email: ceo.email, fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });
const NOW = defaultTaxYear(todayChicago());
const OLD = NOW - 3;
let base = '';
let baseDeposit = 0;
let surchargeCents = 0;

async function client(name: string) {
  const email = `${name.toLowerCase()}@example.test`;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: name, email });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const pu = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [c.id, email]);
  const token = randomBytes(32).toString('base64url');
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [pu.rows[0]!.id, createHash('sha256').update(token).digest('hex')]
  );
  return { contactId: c.id, cookie: { cookie: `saos_portal_session=${token}` } };
}

const quoteLines = (quoteId: string) =>
  app.db.query<{ item_code: string; tax_year: number | null; unit_cents: number | null }>(
    `SELECT item_code, tax_year, unit_cents FROM quote_line_items WHERE quote_id = $1 ORDER BY sort_order`, [quoteId]
  ).then((r) => r.rows);

async function accept(quoteId: string) {
  const sent = await sendQuote(app, quoteId, actor());
  return acceptQuote(app, sent.url.split('/').pop()!, {});
}

before(async () => {
  config = await createTestConfig('multiyear');
  app = buildServer(config);
  await app.ready();
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email: 'ceo-multiyear@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567', totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: staff.email, password: staff.password, totp: code } });
  ceo = { ...staff, token: res.json().token as string };
  // The book in force names the figures; the test never types one.
  const v = await app.db.query<{ item_code: string; amount_cents: number | null; deposit_cents: number | null }>(
    `SELECT i.item_code, i.amount_cents, i.deposit_cents FROM price_book_items i
      WHERE i.version_id = (SELECT id FROM price_book_versions WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE) ORDER BY version_number DESC LIMIT 1)
        AND i.is_active AND (i.item_code = 'PRIOR_YEAR_SURCHARGE' OR (i.item_code LIKE 'IND_BASE%' AND i.deposit_cents IS NOT NULL))
      ORDER BY i.item_code`
  );
  const b = v.rows.find((r) => r.item_code.startsWith('IND_BASE'));
  assert.ok(b, 'an individual base return with a deposit is in the book');
  base = b!.item_code;
  baseDeposit = b!.deposit_cents!;
  surchargeCents = v.rows.find((r) => r.item_code === 'PRIOR_YEAR_SURCHARGE')!.amount_cents!;
});

after(async () => {
  await app.close();
});

test('answer B: a one-year quote for a year more than two back carries the surcharge the server added; a recent year carries none; a typed one is refused', async () => {
  const c = await client('SurchargeOne');
  const old = await createQuote(app, { contactId: c.contactId, lines: [{ itemCode: base }], interviewAnswers: { tax_year: OLD, tax_year_source: 'chosen' } }, actor());
  const lines = await quoteLines(old.id);
  assert.deepEqual(lines.map((l) => `${l.item_code}@${l.tax_year}`), [`${base}@${OLD}`, `PRIOR_YEAR_SURCHARGE@${OLD}`]);
  assert.equal(lines[1]!.unit_cents, surchargeCents, 'priced from the book');
  const recent = await createQuote(app, { contactId: c.contactId, lines: [{ itemCode: base }], interviewAnswers: { tax_year: NOW - 2, tax_year_source: 'chosen' } }, actor());
  assert.deepEqual((await quoteLines(recent.id)).map((l) => l.item_code), [base], 'two back is the e-file lane and carries none');
  await assert.rejects(
    createQuote(app, { contactId: c.contactId, lines: [{ itemCode: base }, { itemCode: 'PRIOR_YEAR_SURCHARGE' }] }, actor()),
    (e: { code?: string }) => e.code === 'surcharge_is_automatic'
  );
  await assert.rejects(
    createQuote(app, { contactId: c.contactId, lines: [{ itemCode: base, taxYear: NOW }, { itemCode: 'IND_SCH_B_D' }] }, actor()),
    (e: { code?: string }) => e.code === 'tax_year_missing',
    'a year on some return lines and not others is refused'
  );
});

test('answer A: a two-year quote is one engagement holding two returns; the surcharge on the older year only; one deposit line per year; per-return readers', async () => {
  const c = await client('TwoYears');
  const q = await createQuote(app, {
    contactId: c.contactId,
    lines: [
      { itemCode: base, taxYear: NOW }, { itemCode: 'IND_SCH_B_D', taxYear: NOW },
      { itemCode: base, taxYear: OLD }, { itemCode: 'IND_SCH_B_D', taxYear: OLD },
    ],
    interviewAnswers: { tax_year: NOW, tax_year_source: 'default' },
  }, actor());
  const lines = await quoteLines(q.id);
  assert.deepEqual(lines.filter((l) => l.item_code === 'PRIOR_YEAR_SURCHARGE').map((l) => l.tax_year), [OLD], 'the surcharge on the older year only');

  const res = await accept(q.id);
  assert.equal(res.engagements.length, 1, 'one engagement');
  const eng = res.engagements[0]!;
  assert.match(eng.title, new RegExp(`^Tax ${NOW}, ${OLD} — `), 'the title lists the years');
  const tes = await app.db.query<{ id: string; tax_year: number; stage: string; return_type: string; engagement_id: string }>(
    `SELECT id, tax_year, stage::text AS stage, return_type::text AS return_type, engagement_id FROM tax_engagements WHERE engagement_id = $1 ORDER BY tax_year DESC`, [eng.id]
  );
  assert.deepEqual(tes.rows.map((t) => `${t.tax_year}:${t.return_type}:${t.stage}`), [`${NOW}:1040:intake_started`, `${OLD}:1040:intake_started`], 'one return per year, each with its own stage');
  const checklists = await app.db.query<{ tax_engagement_id: string; title_en: string }>(
    `SELECT tax_engagement_id, title_en FROM document_requests WHERE engagement_id = $1 AND source = 'checklist' ORDER BY title_en DESC`, [eng.id]
  );
  assert.equal(checklists.rows.length, 2, 'each return its own checklist');
  assert.deepEqual(new Set(checklists.rows.map((r) => r.tax_engagement_id)), new Set(tes.rows.map((t) => t.id)));

  // The deposit: one invoice, one line per year, each year's own.
  const inv = await app.db.query<{ description: string; unit_cents: number }>(
    `SELECT li.description, li.unit_cents FROM invoice_line_items li WHERE li.invoice_id = $1 ORDER BY li.description DESC`, [res.depositInvoiceId]
  );
  assert.deepEqual(inv.rows.map((r) => r.description), [`Deposit — ${NOW}`, `Deposit — ${OLD}`]);
  assert.deepEqual(inv.rows.map((r) => r.unit_cents), [baseDeposit, baseDeposit], 'the deposit rule once per year');

  // Each return's quoted range is its own year's lines; the older year's includes the surcharge.
  const ranges = await Promise.all(tes.rows.map((t) => quotedRangeFor(app, { ...t, estimated_fee_min_cents: null, estimated_fee_max_cents: null })));
  assert.equal(ranges[1]!.min_cents - ranges[0]!.min_cents, surchargeCents, 'the older return reads its surcharge; the newer does not');

  // The portal: one row per year, each with its own lines.
  const portal = await app.inject({ method: 'GET', url: '/portal/engagements', headers: c.cookie });
  const rows = (portal.json().engagements as Array<{ id: string; tax_year: number; tax_engagement_id: string; scope: Array<{ itemCode: string }> }>).filter((r) => r.id === eng.id);
  assert.deepEqual(rows.map((r) => r.tax_year).sort(), [OLD, NOW].sort(), 'two portal rows');
  const oldRow = rows.find((r) => r.tax_year === OLD)!;
  const newRow = rows.find((r) => r.tax_year === NOW)!;
  assert.ok(oldRow.scope.some((s) => s.itemCode === 'PRIOR_YEAR_SURCHARGE') && !newRow.scope.some((s) => s.itemCode === 'PRIOR_YEAR_SURCHARGE'), 'each row reads its own year');

  // A return for a year the engagement holds is named, whichever year: the newest (its period) and the older.
  for (const y of [NOW, OLD]) {
    const r = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(), payload: { contactId: c.contactId, taxYear: y, returnType: '1040', clientType: 'individual', reason: 'Synthetic: a second return for a year the engagement holds.' } });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().error, 'return_exists');
  }
  // A plain quote for the older year alone is a change order: the engagement holding it is the candidate.
  const again = await createQuote(app, { contactId: c.contactId, lines: [{ itemCode: base }], interviewAnswers: { tax_year: OLD, tax_year_source: 'chosen' } }, actor());
  await assert.rejects(sendQuote(app, again.id, actor()), (e: { code?: string }) => e.code === 'change_order_required');
});

test('the key: an engagement holds one return per year, never two for the same year', async () => {
  const c = await client('KeyCheck');
  const q = await createQuote(app, { contactId: c.contactId, lines: [{ itemCode: base, taxYear: NOW }, { itemCode: base, taxYear: NOW - 1 }] }, actor());
  const res = await accept(q.id);
  const eng = res.engagements[0]!.id;
  await assert.rejects(
    app.db.query(`INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type) VALUES ($1, $2, '1040', 'individual')`, [eng, NOW]),
    (e: { code?: string; constraint?: string }) => e.code === '23505' && e.constraint === 'tax_engagements_engagement_year_key'
  );
  const n = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM tax_engagements WHERE engagement_id = $1`, [eng]);
  assert.equal(n.rows[0]!.n, 2, 'two years, two returns, one engagement');
});
