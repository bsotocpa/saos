// ONE ACTIVE ENGAGEMENT PER (CONTACT, SERVICE LINE, PERIOD) — 2026-09-09, Brian's ruling.
//
// #48 guards one quote; this guards one service line. The rule lives in the database as a
// partial unique index; the send gate says it in words first (a plain quote for a line the
// client already has active work on cannot be sent — it must be a change order naming the
// engagement it replaces); acceptance of a change order is atomic inside the #48 claim.
//
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createQuote, sendQuote, acceptQuote } from '../src/modules/pricing/quotes.ts';
import { periodKeyFor, defaultTaxYear, legacyEngagementsWithoutPeriod } from '../src/modules/engagements/period.ts';
import { AppError } from '../src/types.ts';
import { engagementLineFor } from '../src/modules/pricing/engagement-lines.ts';

let app: FastifyInstance;
let config: Config;
let actor: { id: string; email: string; fullName: string; roleKey: 'ceo'; permissions: string[]; sessionId: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

async function itemFor(line: string): Promise<string> {
  // The price book speaks in price lines (individual_tax, business_tax, …); the engagement
  // line is derived by engagementLineFor, exactly as acceptance derives it.
  const { rows } = await app.db.query<{ item_code: string; service_line: string }>(
    `SELECT pbi.item_code, pbi.service_line::text AS service_line FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.is_active AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL AND pbi.deposit_cents > 0
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE)
      ORDER BY pbi.item_code`);
  const hit = rows.find((r) => engagementLineFor(r.service_line, r.item_code) === line);
  assert.ok(hit, `the book has a deposit-carrying item on the ${line} engagement line`);
  return hit!.item_code;
}

let seq = 0;
async function client() {
  seq += 1;
  return makeContact(app.db, { firstName: 'Synthetic', lastName: `Period${seq}`, email: `period-${seq}@example.test` });
}

async function sentQuote(contactId: string, itemCode: string, opts: { changeOrderOf?: string } = {}) {
  const q = await createQuote(app, { contactId, lines: [{ itemCode }] }, actor);
  const s = await sendQuote(app, q.id, actor, opts);
  return { id: q.id, token: s.url.split('/').pop()! };
}

async function engagements(contactId: string) {
  const { rows } = await app.db.query<{ id: string; status: string; service_line: string; period_key: string | null; close_reason: string | null; superseded_by: string | null }>(
    `SELECT id, status::text AS status, service_line::text AS service_line, period_key, close_reason, superseded_by_engagement_id AS superseded_by
       FROM engagements WHERE contact_id = $1 ORDER BY created_at`, [contactId]);
  return rows;
}

before(async () => {
  config = await createTestConfig('engperiod');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  const s = await makeStaff(app.db, config, { email: 'ceo-period@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567' });
  actor = { id: s.id, email: s.email, fullName: 'Synthetic CEO', roleKey: 'ceo', permissions: ['*'], sessionId: 'test' };
});

after(async () => {
  await app.close();
});

test('the period of a line: tax → the year; recurring → ongoing; per-matter → none', () => {
  assert.equal(periodKeyFor('tax', { todayIso: '2026-09-09' }), '2025');
  assert.equal(periodKeyFor('tax', { taxYear: 2023, todayIso: '2026-09-09' }), '2023');
  assert.equal(defaultTaxYear('2026-01-15'), 2025);
  assert.equal(periodKeyFor('bookkeeping', { todayIso: '2026-09-09' }), 'ongoing');
  assert.equal(periodKeyFor('payroll', { todayIso: '2026-09-09' }), 'ongoing');
  assert.equal(periodKeyFor('entity', { todayIso: '2026-09-09' }), null);
});

test('TWO PLAIN ACCEPTS: both quotes sent before either is accepted; the second acceptance is refused by the DATABASE and rolls back whole', async () => {
  const c = await client();
  const item = await itemFor('tax');
  const a = await sentQuote(c.id, item);
  const b = await sentQuote(c.id, item); // sent while a is only sent, not accepted — the send gate cannot know
  const first = await acceptQuote(app, a.token, {});
  assert.ok(first.engagementId);
  await assert.rejects(
    acceptQuote(app, b.token, {}),
    (err: unknown) => err instanceof AppError && err.code === 'engagement_exists',
    'the second plain acceptance is refused — one active tax engagement per year'
  );
  const eng = await engagements(c.id);
  assert.equal(eng.filter((e) => e.status === 'active').length, 1, 'exactly one active engagement');
  assert.equal(eng[0]!.period_key, String(defaultTaxYear(new Date().toISOString())));
  const invoices = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM invoices WHERE contact_id = $1`, [c.id]);
  assert.equal(invoices.rows[0]!.n, 1, 'the refused acceptance left no deposit invoice behind — it rolled back whole');
  const quoteB = await app.db.query<{ status: string }>(`SELECT status::text AS status FROM quotes WHERE id = $1`, [b.id]);
  assert.equal(quoteB.rows[0]!.status, 'sent', 'and the refused quote is back to sent, not stuck in accepted');
});

test('SEND GATE: a plain quote for a line with active work cannot be sent; naming the engagement it replaces can', async () => {
  const c = await client();
  const item = await itemFor('tax');
  const first = await sentQuote(c.id, item);
  await acceptQuote(app, first.token, {});
  const [active] = await engagements(c.id);

  const plain = await createQuote(app, { contactId: c.id, lines: [{ itemCode: item }] }, actor);
  await assert.rejects(
    sendQuote(app, plain.id, actor),
    (err: unknown) => err instanceof AppError && err.code === 'change_order_required' && JSON.stringify(err).includes(active!.id),
    'refused, and the refusal names the engagement a change order would replace'
  );
  const sent = await sendQuote(app, plain.id, actor, { changeOrderOf: active!.id });
  assert.ok(sent.url);
  const q = await app.db.query<{ co: string | null }>(`SELECT change_order_of_engagement_id AS co FROM quotes WHERE id = $1`, [plain.id]);
  assert.equal(q.rows[0]!.co, active!.id, 'the quote records what it replaces');
});

test('CHANGE ORDER: accepted atomically — old withdrawn with the reason, new active, deposit credit carried, one audit row', async () => {
  const c = await client();
  const item = await itemFor('tax');
  const first = await sentQuote(c.id, item);
  const accepted = await acceptQuote(app, first.token, {});
  const [old] = await engagements(c.id);
  // The old engagement's deposit was PAID and is unapplied credit.
  await app.db.query(`UPDATE invoices SET status = 'paid', amount_paid_cents = total_cents, paid_at = now() WHERE id = $1`, [accepted.depositInvoiceId]);

  const co = await sentQuote(c.id, item, { changeOrderOf: old!.id });
  const result = await acceptQuote(app, co.token, {});
  const eng = await engagements(c.id);
  const oldNow = eng.find((e) => e.id === old!.id)!;
  const fresh = eng.find((e) => e.id === result.engagementId)!;
  assert.equal(oldNow.status, 'withdrawn');
  assert.match(oldNow.close_reason ?? '', new RegExp(`superseded by change order ${co.id}`));
  assert.equal(oldNow.superseded_by, fresh.id);
  assert.equal(fresh.status, 'active');
  assert.equal(fresh.period_key, oldNow.period_key, 'same period — that is why it had to be a change order');

  const credit = await app.db.query<{ engagement_id: string }>(`SELECT engagement_id FROM invoices WHERE id = $1`, [accepted.depositInvoiceId]);
  assert.equal(credit.rows[0]!.engagement_id, fresh.id, 'the paid, unapplied deposit now belongs to the new engagement');

  const audit = await app.db.query<{ details: { old_engagement_id: string; new_engagement_id: string; quote_id: string } }>(
    `SELECT details FROM audit_log WHERE action = 'engagement.superseded' AND object_id = $1`, [old!.id]);
  assert.equal(audit.rows.length, 1, 'exactly one audit row for the supersession');
  assert.equal(audit.rows[0]!.details.new_engagement_id, fresh.id);
  assert.equal(audit.rows[0]!.details.quote_id, co.id);
});

test('DIFFERENT PERIODS coexist: a 2024 return and a 2025 return are two legitimate engagements', async () => {
  const c = await client();
  const item = await itemFor('tax');
  const q1 = await sentQuote(c.id, item);
  await acceptQuote(app, q1.token, {});
  // A second quote that names its year explicitly (interview answer).
  const q2 = await createQuote(app, { contactId: c.id, lines: [{ itemCode: item }], interviewAnswers: { tax_year: 2024 } }, actor);
  const s2 = await sendQuote(app, q2.id, actor);
  await acceptQuote(app, s2.url.split('/').pop()!, {});
  const eng = await engagements(c.id);
  assert.deepEqual(eng.filter((e) => e.status === 'active').map((e) => e.period_key).sort(), ['2024', String(defaultTaxYear(new Date().toISOString()))]);
});

test('LEGACY rows (no period) are outside the index and are reported, not guessed', async () => {
  const c = await client();
  await app.db.query(
    `INSERT INTO engagements (contact_id, service_line, status, title) VALUES ($1, 'tax', 'active', 'Legacy one'), ($1, 'tax', 'active', 'Legacy two')`,
    [c.id]
  );
  const report = await legacyEngagementsWithoutPeriod(app);
  const mine = report.byContact.find((r) => r.contact.startsWith('Synthetic P'));
  assert.ok(mine && mine.count >= 2, 'the legacy pair is counted, by contact');
});
