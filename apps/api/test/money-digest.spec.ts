// THE MONEY LINE (2026-09-19, Brian's item 5): actor classes are CEO, staff and system.
// "By staff" counts human staff only. A webhook refund matched to a SAOS-initiated refund is
// attributed to the initiator, once. An unmatched one is money that moved outside the door,
// counted on its own line and never as "by staff". Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import type { StripeAdapter, StripeChargeState } from '../src/modules/billing/stripe.ts';
import { mapStripeEvent } from '../src/modules/billing/stripe.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createInvoice } from '../src/modules/billing/service.ts';
import { voidInvoice } from '../src/modules/billing/void.ts';
import { resyncRefundsFromStripe } from '../src/modules/billing/drift.ts';
import { moneyLineToday, runMoneyDigestJob, type MoneyActionRow } from '../src/modules/billing/money-digest.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff;
let rene: TestStaff;

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

/** What Stripe "says" about a payment intent, steerable per test (the re-sync asks it). */
const charges = new Map<string, StripeChargeState>();
const fakeStripe: StripeAdapter = {
  mode: 'stub',
  keyMode: null,
  // R29 (2026-09-20): the adapter can create refunds; this spec never asks it to.
  async createRefund(): Promise<never> { throw new Error('this spec does not refund'); },
  async createCheckoutSession(input) {
    return { sessionId: `cs_fake_${input.invoiceId}`, url: 'https://checkout.stripe.example/x' };
  },
  async retrieveCheckoutSession() {
    return { status: 'open', paymentStatus: 'unpaid' };
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
async function contact(): Promise<{ id: string }> {
  seq += 1;
  return makeContact(app.db, { firstName: 'Synthetic', lastName: `Money${seq}`, email: `money-${seq}@example.test` });
}

/** A paid invoice, exactly as markInvoicePaid leaves one: paid, settled, payment intent stored. */
async function paidInvoice(cents: number): Promise<{ id: string; number: string; pi: string }> {
  const c = await contact();
  const number = `SM-2026-${String(seq).padStart(4, '0')}`;
  const pi = `pi_test_money_${seq}`;
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at, paid_at,
                           stripe_payment_intent_id)
     VALUES ($1, $2, 'paid', $3, $3, $3, now() - interval '2 days', now() - interval '1 day', $4) RETURNING id`,
    [number, c.id, cents, pi]
  );
  return { id: rows[0]!.id, number, pi };
}

/** An issued, unpaid invoice a person can void. */
async function issuedInvoice(actor: TestStaff): Promise<{ id: string; invoiceNumber: string }> {
  const c = await contact();
  return createInvoice(app, { type: 'staff', id: actor.id, label: actor.fullName }, {
    contactId: c.id, lines: [{ description: 'Books — month', unitCents: 100 }], send: false, issued: true,
  });
}

/** Stripe's charge.refunded for one refund on one invoice, through the real webhook route. */
async function webhookRefund(inv: { pi: string }, refundId: string, cents: number, eventId: string) {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/stripe/charge.refunded.json', import.meta.url), 'utf8'));
  fx.id = eventId;
  fx.data.object.id = `ch_${eventId}`;
  fx.data.object.payment_intent = inv.pi;
  fx.data.object.amount = cents;
  fx.data.object.amount_refunded = cents;
  fx.data.object.refunds.data[0].id = refundId;
  fx.data.object.refunds.data[0].amount = cents;
  fx.data.object.refunds.data[0].charge = fx.data.object.id;
  fx.data.object.refunds.data[0].payment_intent = inv.pi;
  const res = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET, 'content-type': 'application/json' },
    payload: JSON.stringify(fx),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { status: string; recorded: number };
}

const forInvoice = (rows: MoneyActionRow[], number: string) => rows.filter((r) => r.invoiceNumber === number);

before(async () => {
  config = await createTestConfig('moneyline');
  app = buildServer(config, { mailer: silentMailer, stripe: fakeStripe });
  await app.ready();
  ceo = await makeStaff(app.db, config, { email: 'ceo-money@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-12345678' });
  rene = await makeStaff(app.db, config, { email: 'rene-money@example.test', name: 'Synthetic Rene', role: 'comms_billing', password: 'rene-password-1234567' });
});

after(async () => {
  await app.close();
});

test('class ceo: the CEO\'s own void is on neither line', async () => {
  const inv = await issuedInvoice(ceo);
  await voidInvoice(app, inv.id, { reason: 'Superseded by the corrected invoice issued today.' }, { id: ceo.id, fullName: ceo.fullName });
  const line = await moneyLineToday(app, todayChicago());
  assert.equal(forInvoice(line.byStaff, inv.invoiceNumber).length, 0, 'the CEO is not reported to himself');
  assert.equal(forInvoice(line.outsideTheDoor, inv.invoiceNumber).length, 0);
});

test('class staff: a void by a human member of staff is counted by staff, with their id', async () => {
  const inv = await issuedInvoice(rene);
  await voidInvoice(app, inv.id, { reason: 'Superseded by the corrected invoice issued today.' }, { id: rene.id, fullName: rene.fullName });
  const line = await moneyLineToday(app, todayChicago());
  const rows = forInvoice(line.byStaff, inv.invoiceNumber);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.action, 'Void');
  assert.equal(rows[0]!.actorClass, 'staff');
  assert.equal(rows[0]!.actorId, rene.id);
  assert.equal(rows[0]!.actor, 'Synthetic Rene');
  assert.equal(forInvoice(line.outsideTheDoor, inv.invoiceNumber).length, 0);
});

test('a webhook refund matched to a staff-initiated refund is attributed to that staff member, once', async () => {
  const inv = await paidInvoice(2000);
  // Rene records the refund in SAOS first: the SAOS-initiated refund, with its Stripe refund id.
  charges.set(inv.pi, { chargeId: `ch_money_${seq}`, amountCents: 2000, amountRefundedCents: 2000, refunded: true, disputed: false,
    refunds: [{ id: `re_money_${seq}`, amountCents: 2000, reason: 'requested_by_customer', createdAt: new Date().toISOString() }] });
  const r = await resyncRefundsFromStripe(app, inv.id, { type: 'staff', id: rene.id, label: rene.fullName });
  assert.equal(r.recorded, 1);
  // Then Stripe's own event for the same refund arrives.
  const w = await webhookRefund(inv, `re_money_${seq}`, 2000, `evt_money_matched_${seq}`);
  assert.equal(w.status, 'refunded');
  assert.equal(w.recorded, 0, 'the refund id was already on the record');

  const line = await moneyLineToday(app, todayChicago());
  const rows = forInvoice(line.byStaff, inv.number);
  assert.equal(rows.length, 1, 'one money action, not two');
  assert.equal(rows[0]!.action, 'Refund');
  assert.equal(rows[0]!.actorClass, 'staff');
  assert.equal(rows[0]!.actorId, rene.id, 'attributed to the initiator');
  assert.equal(rows[0]!.actor, 'Synthetic Rene');
  assert.equal(rows[0]!.amountCents, 2000);
  assert.equal(forInvoice(line.outsideTheDoor, inv.number).length, 0, 'a matched webhook refund is not outside the door');
});

test('an unmatched webhook refund is outside the door: class system, never by staff', async () => {
  const inv = await paidInvoice(3000);
  const w = await webhookRefund(inv, `re_money_${seq}`, 3000, `evt_money_unmatched_${seq}`);
  assert.equal(w.recorded, 1, 'Stripe told SAOS first');

  const line = await moneyLineToday(app, todayChicago());
  assert.equal(forInvoice(line.byStaff, inv.number).length, 0, 'the webhook is not staff');
  const rows = forInvoice(line.outsideTheDoor, inv.number);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.action, 'Refund');
  assert.equal(rows[0]!.actorClass, 'system');
  assert.equal(rows[0]!.actorId, null);
  assert.equal(rows[0]!.actor, 'stripe webhook');
  assert.equal(rows[0]!.amountCents, 3000);

  // A later re-sync that records nothing is not an initiator and does not move it inside.
  charges.set(inv.pi, { chargeId: `ch_money_${seq}`, amountCents: 3000, amountRefundedCents: 3000, refunded: true, disputed: false,
    refunds: [{ id: `re_money_${seq}`, amountCents: 3000, reason: null, createdAt: new Date().toISOString() }] });
  const r = await resyncRefundsFromStripe(app, inv.id, { type: 'staff', id: rene.id, label: rene.fullName });
  assert.equal(r.recorded, 0);
  const again = await moneyLineToday(app, todayChicago());
  assert.equal(forInvoice(again.byStaff, inv.number).length, 0, 'a re-sync that recorded nothing moved nothing');
  assert.equal(forInvoice(again.outsideTheDoor, inv.number).length, 1, 'still outside the door');
});

test('the executive view carries both lines, and the digest sends class staff only', async () => {
  const line = await moneyLineToday(app, todayChicago());
  const staffNumbers = line.byStaff.map((r) => r.invoiceNumber);
  const outsideNumbers = line.outsideTheDoor.map((r) => r.invoiceNumber);
  assert.ok(staffNumbers.length >= 2 && outsideNumbers.length >= 1, 'the earlier tests left both lines populated');
  assert.ok(!staffNumbers.some((n) => outsideNumbers.includes(n)), 'no invoice is on both lines');

  // The digest for "tomorrow" reads today's window and names only the by-staff rows.
  const today = todayChicago();
  const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const run = await runMoneyDigestJob(app, tomorrow.toISOString().slice(0, 10));
  assert.equal(run.skipped, false);
  assert.equal(run.actions, line.byStaff.length);
  assert.equal(run.outsideTheDoor, line.outsideTheDoor.length);
  assert.equal(run.notified, 1, 'one CEO, one notification');
  const n = await app.db.query<{ body: string }>(`SELECT body FROM notifications WHERE staff_id = $1 AND type LIKE 'money_digest_%' ORDER BY created_at DESC LIMIT 1`, [ceo.id]);
  for (const num of staffNumbers) assert.match(n.rows[0]!.body, new RegExp(num!));
  for (const num of outsideNumbers) assert.doesNotMatch(n.rows[0]!.body, new RegExp(num!), 'outside the door is not "by staff"');
  assert.doesNotMatch(n.rows[0]!.body, /stripe webhook/);
  const record = await app.db.query<{ details: { outside_the_door: number } }>(`SELECT details FROM audit_log WHERE action = 'job.money_digest' ORDER BY id DESC LIMIT 1`);
  assert.equal(record.rows[0]!.details.outside_the_door, line.outsideTheDoor.length, 'counted separately in the run record');
});
