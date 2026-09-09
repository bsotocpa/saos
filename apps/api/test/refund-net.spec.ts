// A PAID-THEN-REFUNDED INVOICE MOVES NOTHING (2026-09-09 overnight, Brian's item 6e):
// zero revenue on the executive dashboard and every report, zero deposit credit. The refund
// arrives through the real webhook path (the charge.refunded fixture). Synthetic data only.
//
// Also 6b: a checkout session Stripe reports as EXPIRED is retired by the sweep, and no
// reconcile_checked row is written for it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import type { StripeAdapter } from '../src/modules/billing/stripe.ts';
import { mapStripeEvent } from '../src/modules/billing/stripe.ts';
import { createTestConfig, makeContact, makeStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { executiveDashboard } from '../src/modules/dashboards/service.ts';
import { REPORTS, runReport } from '../src/modules/reports/service.ts';
import { availableDepositCredit } from '../src/modules/billing/deposit-credit.ts';
import { reconcileInvoice, runPaymentReconcileJob } from '../src/modules/billing/reconcile.ts';
import { createQuote, sendQuote, acceptQuote } from '../src/modules/pricing/quotes.ts';
import { engagementLineFor } from '../src/modules/pricing/engagement-lines.ts';

let app: FastifyInstance;
let config: Config;
let staffId = '';
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

const expiredSessions = new Set<string>();
const fakeStripe: StripeAdapter = {
  mode: 'stub',
  keyMode: null,
  async createCheckoutSession(input) {
    return { sessionId: `cs_fake_${input.invoiceId}`, url: 'https://checkout.stripe.example/x' };
  },
  async retrieveCheckoutSession(sessionId) {
    return expiredSessions.has(sessionId) ? { status: 'expired', paymentStatus: 'unpaid' } : { status: 'open', paymentStatus: 'unpaid' };
  },
  parseWebhookEvent(headers, rawBody, sharedSecret) {
    if (headers['x-webhook-secret'] !== sharedSecret) throw new Error('bad secret');
    return mapStripeEvent(JSON.parse(rawBody.toString('utf8')));
  },
  async listRefunds() {
    return [];
  },
  async expireCheckoutSession() {},
};

const RANGE = { from: '2020-01-01', to: '2030-12-31' };
async function everyNumber() {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(REPORTS)) out[`report:${key}`] = (await runReport(app, key, RANGE)).rows;
  const dash = JSON.parse(JSON.stringify(await executiveDashboard(app))) as Record<string, unknown>;
  const strip = (v: unknown): unknown => Array.isArray(v) ? v.map(strip)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !/(_at|_since|date|updated|generated)$/i.test(k)).map(([k, x]) => [k, strip(x)]))
    : v;
  out.dashboard = strip(dash);
  return out;
}

async function depositItem(): Promise<string> {
  const { rows } = await app.db.query<{ item_code: string; service_line: string }>(
    `SELECT pbi.item_code, pbi.service_line::text AS service_line FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.is_active AND pbi.display_on_quote AND pbi.amount_cents IS NOT NULL AND pbi.deposit_cents > 0
        AND v.effective_from <= CURRENT_DATE AND (v.effective_to IS NULL OR v.effective_to > CURRENT_DATE) ORDER BY pbi.item_code`);
  const hit = rows.find((r) => engagementLineFor(r.service_line, r.item_code) === 'tax');
  assert.ok(hit);
  return hit!.item_code;
}

before(async () => {
  config = await createTestConfig('refundnet');
  app = buildServer(config, { mailer: silentMailer, stripe: fakeStripe });
  await app.ready();
  const s = await makeStaff(app.db, config, { email: 'ceo-refundnet@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567' });
  staffId = s.id;
});

after(async () => {
  await app.close();
});

test('6e: a real client whose deposit is paid then fully refunded moves zero revenue and zero deposit credit', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Refundnet', email: 'refundnet@example.test' });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  const actor = { id: staffId, email: 'ceo-refundnet@example.test', fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' };
  const baseline = await everyNumber();

  // Accept a quote with a deposit; pay the deposit (as the webhook would); it now moves numbers.
  const q = await createQuote(app, { contactId: c.id, lines: [{ itemCode: await depositItem() }] }, actor);
  const s = await sendQuote(app, q.id, actor);
  const accepted = await acceptQuote(app, s.url.split('/').pop()!, {});
  const invoiceId = accepted.depositInvoiceId!;
  await app.db.query(`UPDATE invoices SET status = 'paid', amount_paid_cents = total_cents, paid_at = now(), stripe_payment_intent_id = 'pi_test_refundnet' WHERE id = $1`, [invoiceId]);
  const money = (n: Record<string, unknown>) => ({ revenue: (n.dashboard as { revenue: unknown }).revenue, ar: (n.dashboard as { arAging: unknown }).arAging, collected: n['report:revenue_by_line_month'], aging: n['report:ar_aging'] });
  const paidState = await everyNumber();
  assert.notDeepEqual(money(paidState).revenue, money(baseline).revenue, 'the paid deposit moves collected revenue (so the test below is not vacuous)');
  const creditBefore = await availableDepositCredit(app, accepted.engagementId);
  assert.ok(creditBefore.length === 1 && creditBefore[0]!.availableCents > 0, 'the paid deposit is credit');

  // The refund arrives through the real path.
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/stripe/charge.refunded.json', import.meta.url), 'utf8'));
  const total = (await app.db.query<{ t: number }>(`SELECT total_cents AS t FROM invoices WHERE id = $1`, [invoiceId])).rows[0]!.t;
  fixture.id = 'evt_test_refundnet';
  fixture.data.object.payment_intent = 'pi_test_refundnet';
  fixture.data.object.amount = total;
  fixture.data.object.amount_refunded = total;
  fixture.data.object.refunds.data[0].id = 're_test_refundnet';
  fixture.data.object.refunds.data[0].amount = total;
  const hook = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'x-webhook-secret': config.WEBHOOK_SECRET, 'content-type': 'application/json' }, payload: JSON.stringify(fixture) });
  assert.equal(hook.statusCode, 200, hook.body);
  assert.equal(hook.json().status, 'refunded');

  // The engagement, the task and the pipeline stage are real and rightly move their own
  // numbers. The MONEY must not: dashboard revenue, dashboard A/R, the collected-revenue
  // report, the A/R aging report.
  const after_ = await everyNumber();
  assert.deepEqual(money(after_), money(baseline), 'every money figure is back to baseline — zero net revenue from a refunded deposit');
  assert.deepEqual(await availableDepositCredit(app, accepted.engagementId), [], 'and the refunded deposit is not credit');

  // A PARTIAL refund is the case that exercises the subtraction (a full refund leaves the
  // status filter to do the work): collected must rise by paid minus refunded, not by paid.
  const c2 = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Partialnet', email: 'partialnet@example.test' });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c2.id]);
  const q2 = await createQuote(app, { contactId: c2.id, lines: [{ itemCode: await depositItem() }] }, actor);
  const s2 = await sendQuote(app, q2.id, actor);
  const acc2 = await acceptQuote(app, s2.url.split('/').pop()!, {});
  const inv2 = acc2.depositInvoiceId!;
  await app.db.query(`UPDATE invoices SET status = 'paid', amount_paid_cents = total_cents, paid_at = now(), stripe_payment_intent_id = 'pi_test_partialnet' WHERE id = $1`, [inv2]);
  const total2 = (await app.db.query<{ t: number }>(`SELECT total_cents AS t FROM invoices WHERE id = $1`, [inv2])).rows[0]!.t;
  const half = Math.floor(total2 / 2);
  const fx2 = JSON.parse(readFileSync(new URL('./fixtures/stripe/charge.refunded.json', import.meta.url), 'utf8'));
  fx2.id = 'evt_test_partialnet'; fx2.data.object.payment_intent = 'pi_test_partialnet'; fx2.data.object.amount = total2;
  fx2.data.object.amount_refunded = half; fx2.data.object.refunds.data[0].id = 're_test_partialnet'; fx2.data.object.refunds.data[0].amount = half;
  const hook2 = await app.inject({ method: 'POST', url: '/webhooks/stripe', headers: { 'x-webhook-secret': config.WEBHOOK_SECRET, 'content-type': 'application/json' }, payload: JSON.stringify(fx2) });
  assert.equal(hook2.json().status, 'partially_refunded', hook2.body);
  const partial = await everyNumber();
  const rev = (n: Record<string, unknown>) => (n.dashboard as { revenue: { mtdCents: number; ytdCents: number } }).revenue;
  assert.equal(rev(partial).mtdCents, rev(baseline).mtdCents + (total2 - half), 'month revenue rose by paid minus refunded — not by paid');
  assert.equal(rev(partial).ytdCents, rev(baseline).ytdCents + (total2 - half));
  const credit2 = await availableDepositCredit(app, acc2.engagementId);
  assert.equal(credit2[0]?.availableCents, total2 - half, 'the un-refunded part is still deposit credit');
});

test('6b: a session Stripe reports as expired is retired by the sweep, with no reconcile_checked row', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Expiredsession', email: 'expired-session@example.test' });
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at, stripe_checkout_session_id, updated_at)
     VALUES ('SR-2026-0001', $1, 'sent', 5000, 5000, 0, now() - interval '2 days', 'cs_fake_abandoned', now() - interval '1 day') RETURNING id`, [c.id]);
  const invoiceId = rows[0]!.id;
  expiredSessions.add('cs_fake_abandoned');

  const r = await reconcileInvoice(app, invoiceId);
  assert.equal(r.status, 'stale_session');
  const row = await app.db.query<{ s: string | null }>(`SELECT stripe_checkout_session_id AS s FROM invoices WHERE id = $1`, [invoiceId]);
  assert.equal(row.rows[0]!.s, null, 'retired: the client’s next Pay mints a fresh session');
  const audit = await app.db.query<{ action: string }>(`SELECT action FROM audit_log WHERE object_id = $1 AND action IN ('invoice.reconcile_checked', 'invoice.checkout_session_stale')`, [invoiceId]);
  assert.deepEqual(audit.rows.map((a) => a.action), ['invoice.checkout_session_stale'], 'one stale row, and NO reconcile_checked row');

  const sweep = await runPaymentReconcileJob(app, { graceMinutes: 0 });
  assert.equal(sweep.errors, 0);
  const again = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE object_id = $1 AND action = 'invoice.reconcile_checked'`, [invoiceId]);
  assert.equal(again.rows[0]!.n, 0, 'the sweep never asks about it again');
});
