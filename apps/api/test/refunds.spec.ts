// REFUNDS AND DISPUTES (2026-09-09) — the check that lied.
//
// Brian refunded the first real card payment in the Stripe dashboard. SAOS kept the invoice
// at Paid, and would have forever: it was subscribed to "paid" and "failed" and a refund was
// neither. These tests replay Stripe-trigger-shaped fixtures (test mode, synthetic ids)
// through the SAME webhook route and the SAME event mapping production runs.
//
// Synthetic data only. No real card, no real client.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { drainOutbox } from '../src/outbox.ts';
import { consumeDepositCredit } from '../src/modules/billing/deposit-credit.ts';
import { mapStripeEvent } from '../src/modules/billing/stripe.ts';

let app: FastifyInstance;
let config: Config;
let billingOwner = '';

const sentMail: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    sentMail.push(msg);
    return { id: `captured-${sentMail.length}` };
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(here, 'fixtures', 'stripe', `${name}.json`), 'utf8')) as Record<string, unknown>;

/** A fixture, re-pointed at one invoice's payment intent and given a unique event id. */
function eventFor(name: string, opts: { paymentIntent: string; eventId: string; patch?: (obj: Record<string, unknown>) => void }) {
  const ev = fixture(name);
  ev.id = opts.eventId;
  const obj = (ev.data as { object: Record<string, unknown> }).object;
  obj.payment_intent = opts.paymentIntent;
  // Stripe ids are globally unique and SAOS keys on them; give each event its own so two
  // tests cannot collide on the shared fixture's ids (that collision is not the latch).
  obj.id = `ch_${opts.eventId}`;
  const refunds = obj.refunds as { data?: Array<Record<string, unknown>> } | undefined;
  for (const r of refunds?.data ?? []) {
    r.id = `re_${opts.eventId}`;
    r.charge = obj.id;
    r.payment_intent = opts.paymentIntent;
  }
  opts.patch?.(obj);
  return ev;
}

async function post(ev: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET, 'content-type': 'application/json' },
    payload: JSON.stringify(ev),
  });
}

let seq = 0;
/** A paid invoice, exactly as markInvoicePaid leaves one: paid, settled amount, payment intent stored. */
async function paidInvoice(cents: number): Promise<{ id: string; number: string; pi: string; contactId: string }> {
  seq += 1;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Refund${seq}`, email: `refund-${seq}@example.test` });
  const pi = `pi_test_synthetic_${String(seq).padStart(4, '0')}`;
  const number = `SY-2026-${String(seq).padStart(4, '0')}`;
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents,
                           sent_at, paid_at, stripe_payment_intent_id)
     VALUES ($1, $2, 'paid', $3, $3, $3, now() - interval '1 day', now(), $4) RETURNING id`,
    [number, c.id, cents, pi]
  );
  return { id: rows[0]!.id, number, pi, contactId: c.id };
}

async function invoiceState(id: string) {
  const { rows } = await app.db.query<{ status: string; amount_paid_cents: number; amount_refunded_cents: number }>(
    `SELECT status::text AS status, amount_paid_cents, amount_refunded_cents FROM invoices WHERE id = $1`, [id]);
  return rows[0]!;
}

before(async () => {
  config = await createTestConfig('refunds');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  const rene = await makeStaff(app.db, config, {
    email: 'rene-refunds@example.test', name: 'Synthetic Rene', role: 'comms_billing', password: 'rene-password-1234567',
  });
  billingOwner = rene.id;
});

after(async () => {
  await app.close();
});

// ── The event that was never heard ─────────────────────────────────────────

test('charge.refunded: the invoice stops saying Paid — refund row, amounts reversed, receipt queued', async () => {
  const inv = await paidInvoice(2000);
  sentMail.length = 0;

  const res = await post(eventFor('charge.refunded', { paymentIntent: inv.pi, eventId: 'evt_test_refund_full_1' }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'refunded');
  assert.equal(res.json().recorded, 1, 'one refund row written by this delivery');

  const state = await invoiceState(inv.id);
  assert.equal(state.status, 'refunded', 'a fully refunded invoice does not read Paid');
  assert.equal(state.amount_refunded_cents, 2000, 'gross, as Stripe reports it');
  assert.equal(state.amount_paid_cents, 2000, 'what was paid is history and stays');

  const refunds = await app.db.query<{ stripe_refund_id: string; amount_cents: number; reason: string | null }>(
    `SELECT stripe_refund_id, amount_cents, reason FROM invoice_refunds WHERE invoice_id = $1`, [inv.id]);
  assert.equal(refunds.rows.length, 1);
  assert.equal(refunds.rows[0]!.stripe_refund_id, 're_evt_test_refund_full_1');
  assert.equal(refunds.rows[0]!.amount_cents, 2000);
  assert.equal(refunds.rows[0]!.reason, 'requested_by_customer', 'the reason rides along when Stripe gives one');

  const audit = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE object_id = $1 AND action = 'invoice.refunded'`, [inv.id]);
  assert.equal(audit.rows[0]!.n, 1);

  // The receipt is an outbox effect: nothing left during the webhook, and the drain sends it.
  assert.equal(sentMail.length, 0, 'the webhook itself sent nothing');
  const queued = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM outbox WHERE effect = 'invoice.refund_receipt' AND payload->>'refundId' = 're_evt_test_refund_full_1' AND contact_id = $1`, [inv.contactId]);
  assert.equal(queued.rows.length, 1, 'exactly one receipt queued for this refund');
  const drained = await drainOutbox(app);
  assert.ok(drained.sent >= 1);
  const receipt = sentMail.find((m) => m.to === `refund-${seq}@example.test`);
  assert.ok(receipt, 'the client was told');
  assert.match(receipt!.subject, /Refund/);
  assert.match(receipt!.subject, /\$20\.00/);
});

test('THE REPLAY: the same charge.refunded delivered twice records ONE refund and queues ONE receipt', async () => {
  const inv = await paidInvoice(2000);
  const ev = eventFor('charge.refunded', { paymentIntent: inv.pi, eventId: 'evt_test_refund_replay_1' });

  const first = await post(ev);
  assert.equal(first.json().status, 'refunded');
  const second = await post(ev);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().status, 'duplicate', 'the latch answered — nothing was performed');

  const refunds = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM invoice_refunds WHERE invoice_id = $1`, [inv.id]);
  assert.equal(refunds.rows[0]!.n, 1, 'exactly one refund row');
  const audits = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE object_id = $1 AND action = 'invoice.refunded'`, [inv.id]);
  assert.equal(audits.rows[0]!.n, 1, 'exactly one reversal on the record');
  const receipts = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox WHERE effect = 'invoice.refund_receipt' AND contact_id = $1`, [inv.contactId]);
  assert.equal(receipts.rows[0]!.n, 1, 'exactly one receipt');
  assert.equal((await invoiceState(inv.id)).amount_refunded_cents, 2000, 'not doubled');
  const latch = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM stripe_events WHERE event_id = 'evt_test_refund_replay_1'`);
  assert.equal(latch.rows[0]!.n, 1, 'one latch row for one event id');
});

test('a partial refund reads partly refunded, and the un-refunded part is still deposit credit; a full one leaves none', async () => {
  const partial = await paidInvoice(20000);
  const res = await post(eventFor('charge.refunded', {
    paymentIntent: partial.pi, eventId: 'evt_test_refund_partial_1',
    patch: (obj) => {
      obj.amount = 20000; obj.amount_refunded = 5000;
      (obj.refunds as { data: Array<Record<string, unknown>> }).data[0]!.amount = 5000;
    },
  }));
  assert.equal(res.json().status, 'partially_refunded');
  assert.equal((await invoiceState(partial.id)).amount_refunded_cents, 5000);
  // Deposit credit is paid minus refunded: 15000 remains creditable, not 20000.
  assert.equal(await consumeDepositCredit(app, partial.id, 99999), 15000, 'credit is what is still paid');

  const full = await paidInvoice(2000);
  await post(eventFor('charge.refunded', { paymentIntent: full.pi, eventId: 'evt_test_refund_full_2' }));
  assert.equal(await consumeDepositCredit(app, full.id, 99999), 0, 'a refunded deposit can never be applied to a later invoice');
});

// ── Disputes ───────────────────────────────────────────────────────────────

test('charge.dispute.created: status disputed, a task for the billing owner due on the network deadline, no client send', async () => {
  const inv = await paidInvoice(2000);
  const disputing = `refund-${seq}@example.test`;
  sentMail.length = 0;
  const res = await post(eventFor('charge.dispute.created', { paymentIntent: inv.pi, eventId: 'evt_test_dispute_open_1',
    patch: (obj) => { obj.id = 'dp_test_synthetic_open_1'; } }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'disputed');
  assert.equal((await invoiceState(inv.id)).status, 'disputed');

  const task = await app.db.query<{ id: string; assigned_staff_id: string; due_date: string; status: string; title: string }>(
    `SELECT id, assigned_staff_id, to_char(due_date, 'YYYY-MM-DD') AS due_date, status::text AS status, title
       FROM tasks WHERE source_type = 'stripe_dispute' AND source_id = 'dp_test_synthetic_open_1'`);
  assert.equal(task.rows.length, 1, 'one task through the one door');
  assert.equal(task.rows[0]!.assigned_staff_id, billingOwner, 'assigned to the billing role');
  // evidence_details.due_by 1789800000 = 2026-09-19T06:40:00Z
  assert.equal(task.rows[0]!.due_date, '2026-09-19', 'due date is the card network deadline from the payload');
  assert.match(task.rows[0]!.title, /SY-2026-/);
  assert.ok(!sentMail.some((m) => m.to === disputing), 'the client — who is the one disputing — is sent nothing');

  const dispute = await app.db.query<{ status: string; task_id: string; evidence_due_by: Date }>(
    `SELECT status, task_id, evidence_due_by FROM invoice_disputes WHERE stripe_dispute_id = 'dp_test_synthetic_open_1'`);
  assert.equal(dispute.rows[0]!.status, 'needs_response');
  assert.equal(dispute.rows[0]!.task_id, task.rows[0]!.id);
  await drainOutbox(app); // may deliver EARLIER tests' receipts; none may be for this client
  assert.ok(!sentMail.some((m) => m.to === disputing), 'and nothing was queued for them either');
});

test('charge.dispute.closed won: back to paid and the task closes itself', async () => {
  const inv = await paidInvoice(2000);
  await post(eventFor('charge.dispute.created', { paymentIntent: inv.pi, eventId: 'evt_test_dispute_open_2',
    patch: (obj) => { obj.id = 'dp_test_synthetic_won'; } }));
  const res = await post(eventFor('charge.dispute.closed', { paymentIntent: inv.pi, eventId: 'evt_test_dispute_closed_won',
    patch: (obj) => { obj.id = 'dp_test_synthetic_won'; obj.status = 'won'; } }));
  assert.equal(res.json().status, 'dispute_won');
  assert.equal((await invoiceState(inv.id)).status, 'paid', 'the charge stands');
  const task = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM tasks WHERE source_type = 'stripe_dispute' AND source_id = 'dp_test_synthetic_won'`);
  assert.notEqual(task.rows[0]!.status, 'not_started', 'the task is no longer open');
  assert.notEqual(task.rows[0]!.status, 'in_progress');
  const d = await app.db.query<{ outcome: string; closed_at: Date | null }>(
    `SELECT outcome, closed_at FROM invoice_disputes WHERE stripe_dispute_id = 'dp_test_synthetic_won'`);
  assert.equal(d.rows[0]!.outcome, 'won');
  assert.ok(d.rows[0]!.closed_at);
});

test('charge.dispute.closed lost: treated exactly as a refund, keyed by the dispute so a replay cannot take the money twice', async () => {
  const inv = await paidInvoice(2000);
  await post(eventFor('charge.dispute.created', { paymentIntent: inv.pi, eventId: 'evt_test_dispute_open_3',
    patch: (obj) => { obj.id = 'dp_test_synthetic_lost'; } }));
  const ev = eventFor('charge.dispute.closed', { paymentIntent: inv.pi, eventId: 'evt_test_dispute_closed_lost',
    patch: (obj) => { obj.id = 'dp_test_synthetic_lost'; obj.status = 'lost'; } });
  const res = await post(ev);
  assert.equal(res.json().status, 'dispute_lost');
  const state = await invoiceState(inv.id);
  assert.equal(state.status, 'refunded');
  assert.equal(state.amount_refunded_cents, 2000);
  const row = await app.db.query<{ stripe_refund_id: string; reason: string }>(
    `SELECT stripe_refund_id, reason FROM invoice_refunds WHERE invoice_id = $1`, [inv.id]);
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0]!.stripe_refund_id, 'dispute:dp_test_synthetic_lost');
  assert.equal(row.rows[0]!.reason, 'dispute_lost');

  const replay = await post(ev);
  assert.equal(replay.json().status, 'duplicate');
  assert.equal((await invoiceState(inv.id)).amount_refunded_cents, 2000, 'not doubled');
});

// ── Money that matches nothing ─────────────────────────────────────────────

test('a refund for a payment SAOS has no invoice for raises a task naming the Stripe ids, and is not lost', async () => {
  const res = await post(eventFor('charge.refunded', { paymentIntent: 'pi_test_nobody_knows', eventId: 'evt_test_refund_unmatched' }));
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'unmatched');
  const task = await app.db.query<{ title: string; assigned_staff_id: string }>(
    `SELECT title, assigned_staff_id FROM tasks WHERE source_type = 'stripe_unmatched' AND source_id = 'evt_test_refund_unmatched'`);
  assert.equal(task.rows.length, 1);
  assert.match(task.rows[0]!.title, /matches no invoice/);
  assert.equal(task.rows[0]!.assigned_staff_id, billingOwner);
});

// ── The same mapping for the live shape ────────────────────────────────────

test('the mapping reads the live event shape identically (one parser for fixtures and production)', () => {
  const ev = mapStripeEvent(fixture('charge.refunded') as never);
  assert.equal(ev.type, 'refund');
  if (ev.type !== 'refund') return;
  assert.equal(ev.eventId, 'evt_test_charge_refunded_0001');
  assert.equal(ev.amountRefundedCents, 2000);
  assert.equal(ev.refunds[0]!.id, 're_test_synthetic_0001');
  const opened = mapStripeEvent(fixture('charge.dispute.created') as never);
  assert.equal(opened.type, 'dispute_opened');
  if (opened.type === 'dispute_opened') assert.equal(opened.evidenceDueBy, '2026-09-19T06:40:00.000Z');
  const unknown = mapStripeEvent({ id: 'evt_x', type: 'customer.created', data: { object: {} } });
  assert.equal(unknown.type, 'ignored');
});

// ── The subscription itself is part of the rule ────────────────────────────

test('every installer and the repair script subscribe the endpoint to the three events', () => {
  const root = resolve(here, '..', '..', '..');
  for (const f of ['scripts/install-stripe-live.sh', 'scripts/install-stripe-test.sh', 'scripts/repair-stripe-webhook.sh', 'scripts/stripe-webhook-events.mjs']) {
    const text = readFileSync(join(root, f), 'utf8');
    for (const ev of ['charge.refunded', 'charge.dispute.created', 'charge.dispute.closed']) {
      assert.ok(text.includes(ev), `${f} must subscribe ${ev} — a fresh install that cannot hear a refund is the 2026-09-09 bug again`);
    }
  }
});
