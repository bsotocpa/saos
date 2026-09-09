// THE INVOICE STATE MACHINE (2026-09-09, Brian's ruling after SA-2026-0003 read Paid twice).
//
// The reconcile sweep wrote paid over refunded: the Checkout Session's payment_status stays
// paid after a refund, and nothing in the database knew the transition was illegal. Now the
// database holds every legal transition (migration 0084), the sweep only touches sent/overdue,
// markInvoicePaid refuses a refunded invoice, a nightly drift check compares Stripe with SAOS
// and raises a task, and re-sync is the deliberate, audited correction.
//
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import type { StripeAdapter, StripeChargeState } from '../src/modules/billing/stripe.ts';
import { mapStripeEvent } from '../src/modules/billing/stripe.ts';
import { createTestConfig, makeContact } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { markInvoicePaid } from '../src/modules/billing/service.ts';
import { runPaymentReconcileJob } from '../src/modules/billing/reconcile.ts';
import { runStripeDriftCheckJob, resyncRefundsFromStripe } from '../src/modules/billing/drift.ts';

let app: FastifyInstance;
let config: Config;

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

/** What Stripe "says" about a payment intent, steerable per test. */
const charges = new Map<string, StripeChargeState>();
const fakeStripe: StripeAdapter = {
  mode: 'stub',
  keyMode: null,
  async createCheckoutSession(input) {
    return { sessionId: `cs_fake_${input.invoiceId}`, url: 'https://checkout.stripe.example/x' };
  },
  // The trap itself: a Checkout Session stays "paid" after the charge was refunded.
  async retrieveCheckoutSession(sessionId) {
    return { status: 'complete', paymentStatus: 'paid', paymentIntentId: `pi_for_${sessionId}` };
  },
  parseWebhookEvent(headers, rawBody, sharedSecret) {
    if (headers['x-webhook-secret'] !== sharedSecret) throw new Error('bad secret');
    return mapStripeEvent(JSON.parse(rawBody.toString('utf8')));
  },
  async listRefunds() {
    return [];
  },
  async expireCheckoutSession() {},
  async retrieveCharge(paymentIntentId) {
    return charges.get(paymentIntentId) ?? null;
  },
};

let seq = 0;
async function paidInvoice(cents = 2000) {
  seq += 1;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `State${seq}`, email: `state-${seq}@example.test` });
  const number = `SS-2026-${String(seq).padStart(4, '0')}`;
  const pi = `pi_test_state_${seq}`;
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at, paid_at,
                           stripe_payment_intent_id, stripe_checkout_session_id)
     VALUES ($1, $2, 'paid', $3, $3, $3, now() - interval '2 days', now() - interval '1 day', $4, $5) RETURNING id`,
    [number, c.id, cents, pi, `cs_fake_${number}`]
  );
  return { id: rows[0]!.id, number, contactId: c.id, pi };
}

async function refundViaWebhook(inv: { id: string; pi: string }, amount: number, total: number, tag: string) {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/stripe/charge.refunded.json', import.meta.url), 'utf8'));
  fx.id = `evt_test_state_${tag}`;
  fx.data.object.payment_intent = inv.pi;
  fx.data.object.amount = total;
  fx.data.object.amount_refunded = amount;
  fx.data.object.refunds.data[0].id = `re_test_state_${tag}`;
  fx.data.object.refunds.data[0].amount = amount;
  const res = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET, 'content-type': 'application/json' },
    payload: JSON.stringify(fx),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json();
}

async function status(id: string) {
  const { rows } = await app.db.query<{ status: string; amount_refunded_cents: number }>(
    `SELECT status::text AS status, amount_refunded_cents FROM invoices WHERE id = $1`, [id]);
  return rows[0]!;
}

before(async () => {
  config = await createTestConfig('invstate');
  app = buildServer(config, { mailer: silentMailer, stripe: fakeStripe });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('THE BUG: the sweep no longer rewrites a refunded invoice as paid — the row stays refunded', async () => {
  const inv = await paidInvoice(2000);
  await refundViaWebhook(inv, 2000, 2000, 'sweep');
  assert.equal((await status(inv.id)).status, 'refunded');
  await app.db.query(`UPDATE invoices SET updated_at = now() - interval '1 hour' WHERE id = $1`, [inv.id]);
  const sweep = await runPaymentReconcileJob(app, { graceMinutes: 0 });
  assert.equal((await status(inv.id)).status, 'refunded', 'Stripe still says the SESSION is paid; the invoice was refunded; the sweep must not touch it');
  assert.equal(sweep.settled, 0);
});

test('the DATABASE refuses refunded → paid on a raw UPDATE (the sabotage target)', async () => {
  const inv = await paidInvoice(2000);
  await refundViaWebhook(inv, 2000, 2000, 'raw');
  await assert.rejects(
    app.db.query(`UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = $1`, [inv.id]),
    (err: { message: string }) => /cannot move from refunded to paid/.test(err.message),
    'the rule is in the database, not the sweep'
  );
  assert.equal((await status(inv.id)).status, 'refunded');
});

test('refunded → paid IS legal with a NEW payment intent — a new payment record', async () => {
  const inv = await paidInvoice(2000);
  await refundViaWebhook(inv, 2000, 2000, 'newpi');
  await app.db.query(`UPDATE invoices SET status = 'paid', stripe_payment_intent_id = 'pi_test_state_newpi_second' WHERE id = $1`, [inv.id]);
  assert.equal((await status(inv.id)).status, 'paid');
});

test('paid → refunded needs a refund row; void is terminal', async () => {
  const inv = await paidInvoice(2000);
  await assert.rejects(
    app.db.query(`UPDATE invoices SET status = 'refunded', amount_refunded_cents = 2000 WHERE id = $1`, [inv.id]),
    (err: { message: string }) => /without a refund row/.test(err.message)
  );
  const v = await paidInvoice(500);
  await app.db.query(`UPDATE invoices SET status = 'sent', amount_paid_cents = 0, paid_at = NULL WHERE id = $1`, [v.id]).catch(() => {});
  // (paid → sent is not a legal transition either; the void checks live in invoice-void.spec)
  assert.equal((await status(v.id)).status, 'paid', 'paid does not go back to sent');
});

test('markInvoicePaid refuses a refunded invoice in words, before the database has to', async () => {
  const inv = await paidInvoice(2000);
  await refundViaWebhook(inv, 2000, 2000, 'mip');
  const r = await markInvoicePaid(app, inv.id, { paymentIntentId: inv.pi });
  assert.equal(r.refused, 'refunded');
  assert.equal((await status(inv.id)).status, 'refunded');
});

test('nightly drift check: SAOS says paid, Stripe says refunded → one task, nothing corrected', async () => {
  const inv = await paidInvoice(2000);
  charges.set(inv.pi, { chargeId: 'ch_test_drift', amountCents: 2000, amountRefundedCents: 2000, refunded: true, disputed: false,
    refunds: [{ id: 're_test_drift', amountCents: 2000, reason: 'requested_by_customer', createdAt: new Date().toISOString() }] });
  const run = await runStripeDriftCheckJob(app, '2099-01-01');
  assert.ok(run.drifted >= 1, 'the disagreement is seen');
  assert.equal((await status(inv.id)).status, 'paid', 'NOT auto-corrected');
  const task = await app.db.query<{ title: string }>(`SELECT title FROM tasks WHERE source_type = 'stripe_drift' AND source_id = $1`, [inv.id]);
  assert.equal(task.rows.length, 1, 'a person is told, once');
  assert.match(task.rows[0]!.title, /SAOS says paid, Stripe says refunded/);
  // Same day, second run: idempotent.
  const again = await runStripeDriftCheckJob(app, '2099-01-01');
  assert.equal(again.skipped, true);
});

test('re-sync from Stripe is the deliberate correction: refunds recorded, status refunded, audited', async () => {
  const inv = await paidInvoice(2000);
  charges.set(inv.pi, { chargeId: 'ch_test_resync', amountCents: 2000, amountRefundedCents: 2000, refunded: true, disputed: false,
    refunds: [{ id: 're_test_resync', amountCents: 2000, reason: 'requested_by_customer', createdAt: new Date().toISOString() }] });
  const r = await resyncRefundsFromStripe(app, inv.id, { type: 'system', label: 'test' });
  assert.equal(r.status, 'refunded');
  assert.equal(r.recorded, 1);
  const s = await status(inv.id);
  assert.equal(s.status, 'refunded');
  assert.equal(s.amount_refunded_cents, 2000);
  const audit = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'invoice.refunds_resynced' AND object_id = $1`, [inv.id]);
  assert.equal(audit.rows.length, 1);
  // Idempotent: a second re-sync records nothing new and changes nothing.
  const r2 = await resyncRefundsFromStripe(app, inv.id, { type: 'system', label: 'test' });
  assert.equal(r2.recorded, 0);
  assert.equal((await status(inv.id)).status, 'refunded');
});
