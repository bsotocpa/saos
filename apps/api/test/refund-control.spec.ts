/*
 * THE REFUND DOOR (Brian, ruling R29, 2026-09-20).
 *
 * Money went back through the Stripe dashboard until tonight; SAOS heard about it from a webhook, or
 * a fortnight later from a nightly drift check. This is the door in the other direction, and these
 * tests push on every part of it that could let money move on a wrong premise:
 *
 *   the bounds     a refund is a positive amount no larger than what is still refundable, on an
 *                  invoice that was actually paid and is not under dispute, with a standalone
 *                  reason — and every refusal happens BEFORE Stripe is called;
 *   the actor      the row carries the person, because a refund with no author is how a firm
 *                  discovers it has no refund policy;
 *   the adapter    called exactly once per refund, and idempotent on its key, so a double-pressed
 *                  control is one refund;
 *   the receipt    the same gated `refund_receipt` automation the webhook uses — suppressed and
 *                  recorded while it is off, sent when Brian arms it, never bypassed;
 *   the webhook    Stripe's charge.refunded for a refund the door already made updates THAT row and
 *                  queues no second receipt, and audits a reconciliation rather than a second
 *                  refund, so the CEO's money line counts the money once, against the person;
 *   the role       billing.manage or the CEO. The bookkeeper is refused 403.
 *   the switch     (2026-09-20) OPS_REFUND_CONTROL, default OFF: the route answers 409 with the one
 *                  sentence the row shows, before it reads the body and before Stripe is asked; the
 *                  session reports the state; and a refund made in the Stripe dashboard still lands
 *                  on the invoice through the webhook, because that path has no switch. This spec
 *                  turns the switch ON for the door tests, the way the harness boot does.
 *
 * Synthetic data only: no real card, no real client, no live Stripe call. The Stripe adapter under
 * test is the REAL stub (makeStripeAdapter under NODE_ENV=test) wrapped in a counter, so what the
 * harness leans on is what is proven here.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import type { RefundRequest, StripeAdapter } from '../src/modules/billing/stripe.ts';
import { makeStripeAdapter } from '../src/modules/billing/stripe.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from '../test/helpers.ts';
import { loadConfig } from '../src/config.ts';
import { readdirSync, statSync } from 'node:fs';
import type { Config } from '../src/config.ts';
import { drainOutbox } from '../src/outbox.ts';
import { moneyLineToday } from '../src/modules/billing/money-digest.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff & { token: string };
let ceo: TestStaff & { token: string };
let bookkeeper: TestStaff & { token: string };

const sentMail: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    sentMail.push(msg);
    return { id: `captured-${sentMail.length}` };
  },
};

const here = dirname(fileURLToPath(import.meta.url));

/** The REAL stub adapter, with every createRefund call remembered. */
const refundCalls: RefundRequest[] = [];
let stripe: StripeAdapter;

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

let seq = 0;
/** A paid invoice, exactly as markInvoicePaid leaves one. `pi: null` for one that never met Stripe. */
async function paidInvoice(cents: number, opts: { status?: string; pi?: boolean } = {}) {
  seq += 1;
  const email = `refundctl-${seq}@example.test`;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Refundctl${seq}`, email });
  const status = opts.status ?? 'paid';
  const pi = opts.pi === false ? null : `pi_test_refundctl_${String(seq).padStart(4, '0')}`;
  const number = `SR-2026-${String(seq).padStart(4, '0')}`;
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents,
                           sent_at, paid_at, stripe_payment_intent_id)
     VALUES ($1, $2, $3::invoice_status, $4, $4,
             CASE WHEN $3 IN ('paid', 'partially_refunded') THEN $4 ELSE 0 END,
             now() - interval '2 days',
             CASE WHEN $3 IN ('paid', 'partially_refunded') THEN now() - interval '1 day' ELSE NULL END,
             $5)
     RETURNING id`,
    [number, c.id, status, cents, pi]
  );
  return { id: rows[0]!.id, number, contactId: c.id, email, pi };
}

async function invoiceState(id: string) {
  const { rows } = await app.db.query<{ status: string; amount_paid_cents: number; amount_refunded_cents: number }>(
    `SELECT status::text AS status, amount_paid_cents, amount_refunded_cents FROM invoices WHERE id = $1`, [id]);
  return rows[0]!;
}

async function refundRows(invoiceId: string) {
  const { rows } = await app.db.query<{
    stripe_refund_id: string; amount_cents: number; reason: string | null; stripe_event_id: string | null;
    refunded_by_staff_id: string | null; refunded_by_label: string | null;
  }>(
    `SELECT stripe_refund_id, amount_cents, reason, stripe_event_id, refunded_by_staff_id, refunded_by_label
       FROM invoice_refunds WHERE invoice_id = $1 ORDER BY created_at, id`,
    [invoiceId]
  );
  return rows;
}

async function arm(key: string, enabled: boolean) {
  await app.db.query(`UPDATE automations SET enabled = $2 WHERE key = $1`, [key, enabled]);
}

/** The words a zod refusal carries: the first issue's message, which is what the modal shows. */
function issue(body: unknown): string {
  const issues = (body as { issues?: Array<{ message?: string }> }).issues ?? [];
  return issues.find((i) => i.message)?.message ?? JSON.stringify(body);
}

async function refund(who: { token: string }, invoiceId: string, body: unknown) {
  return app.inject({ method: 'POST', url: `/invoices/${invoiceId}/refund`, headers: auth(who), payload: body as never });
}

/** Stripe's charge.refunded for one refund on one invoice, through the real webhook route. */
async function webhookRefund(inv: { pi: string | null }, refund_: { id: string; cents: number }, cumulativeCents: number, eventId: string) {
  const fx = JSON.parse(readFileSync(join(here, 'fixtures', 'stripe', 'charge.refunded.json'), 'utf8')) as {
    id: string; data: { object: Record<string, unknown> };
  };
  fx.id = eventId;
  const obj = fx.data.object;
  obj.id = `ch_${eventId}`;
  obj.payment_intent = inv.pi;
  obj.amount_refunded = cumulativeCents;
  const list = (obj.refunds as { data: Array<Record<string, unknown>> }).data;
  list[0]!.id = refund_.id;
  list[0]!.amount = refund_.cents;
  list[0]!.charge = obj.id;
  list[0]!.payment_intent = inv.pi;
  const res = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET, 'content-type': 'application/json' },
    payload: JSON.stringify(fx),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { status: string; recorded: number; reconciled: number; reconciledToTheDoor?: boolean };
}

before(async () => {
  // The switch is OFF by default; the door is proven with it ON, as the harness boot runs it.
  config = { ...(await createTestConfig('refundcontrol')), OPS_REFUND_CONTROL: 'on' };
  const real = makeStripeAdapter(config);
  stripe = {
    ...real,
    async createRefund(input) {
      refundCalls.push(input);
      return real.createRefund(input);
    },
  };
  app = buildServer(config, { mailer: capturingMailer, stripe });
  await app.ready();
  rene = await staffWithToken('rene-refundctl@example.test', 'comms_billing');
  ceo = await staffWithToken('ceo-refundctl@example.test', 'ceo');
  bookkeeper = await staffWithToken('books-refundctl@example.test', 'bookkeeper');
});

after(async () => {
  await app.close();
});

// ── The door ───────────────────────────────────────────────────────────────

test('a partial refund: Stripe called once, the row carries the person, the invoice reads partly refunded', async () => {
  const inv = await paidInvoice(20000);
  refundCalls.length = 0;
  await arm('refund_receipt', false); // as it ships: OFF until Brian arms it

  const res = await refund(rene, inv.id, { amountCents: 5000, reason: 'The client cancelled the quarter before it started and asked for the difference back.' });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { status: string; amountCents: number; refundableCents: number; stripeRefundId: string; refundedBy: string };
  assert.equal(body.status, 'partially_refunded');
  assert.equal(body.amountCents, 5000);
  assert.equal(body.refundableCents, 15000, 'what is left refundable comes back, so the control can offer it next time');
  assert.match(body.stripeRefundId, /^re_stub_/);
  assert.equal(body.refundedBy, 'Synthetic comms_billing');

  assert.equal(refundCalls.length, 1, 'the Stripe adapter was asked exactly once');
  assert.equal(refundCalls[0]!.paymentIntentId, inv.pi, 'against the payment intent this invoice settled on');
  assert.equal(refundCalls[0]!.amountCents, 5000);
  assert.ok(refundCalls[0]!.idempotencyKey.includes(inv.id), 'with an idempotency key naming the invoice');

  const state = await invoiceState(inv.id);
  assert.equal(state.status, 'partially_refunded');
  assert.equal(state.amount_refunded_cents, 5000);
  assert.equal(state.amount_paid_cents, 20000, 'what was paid is history and stays');

  const rows = await refundRows(inv.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.amount_cents, 5000);
  assert.equal(rows[0]!.refunded_by_staff_id, rene.id, 'the actor is on the refund row, not only in the audit log');
  assert.equal(rows[0]!.refunded_by_label, 'Synthetic comms_billing');
  assert.doesNotMatch(rows[0]!.refunded_by_label!, /@/, 'a name, never an email');
  assert.equal(rows[0]!.reason, 'The client cancelled the quarter before it started and asked for the difference back.');
  assert.equal(rows[0]!.stripe_event_id, null, 'no Stripe event confirmed it yet');

  const audit = await app.db.query<{ actor_id: string; details: { amount_cents: number; reason: string; stripe_refund_id: string } }>(
    `SELECT actor_id, details FROM audit_log WHERE object_id = $1 AND action = 'invoice.refund_issued'`, [inv.id]);
  assert.equal(audit.rows.length, 1, 'one money action on the record');
  assert.equal(audit.rows[0]!.actor_id, rene.id);
  assert.equal(audit.rows[0]!.details.amount_cents, 5000);
  assert.equal(audit.rows[0]!.details.stripe_refund_id, body.stripeRefundId);

  // THE GATE. The receipt is queued behind refund_receipt, which is off: held, and the hold recorded.
  sentMail.length = 0;
  await drainOutbox(app);
  assert.equal(sentMail.filter((m) => m.to === inv.email).length, 0, 'nothing reached the client while the automation is off');
  const held = await app.db.query(
    `SELECT 1 FROM audit_log WHERE action = 'invoice.refund_receipt_suppressed' AND object_id = $1`, [inv.id]);
  assert.equal(held.rows.length, 1, 'the suppression is counted on the invoice send log, not silent');
});

test('the rest of the money: a second refund flips it to refunded, and the receipt leaves once the automation is armed', async () => {
  const inv = await paidInvoice(2000);
  await arm('refund_receipt', true);
  sentMail.length = 0;

  const res = await refund(ceo, inv.id, { amountCents: 2000, reason: 'Duplicate payment on this engagement; the whole amount goes back.' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((res.json() as { status: string }).status, 'refunded');
  assert.equal((await invoiceState(inv.id)).status, 'refunded');
  assert.equal((await invoiceState(inv.id)).amount_refunded_cents, 2000);

  await drainOutbox(app);
  const receipt = sentMail.find((m) => m.to === inv.email);
  assert.ok(receipt, 'the client was told the money went back');
  assert.match(receipt!.subject, /Refund/);
  assert.match(receipt!.subject, /\$20\.00/);

  // Nothing is refundable now, and the door says so rather than calling Stripe again.
  const again = await refund(ceo, inv.id, { amountCents: 100, reason: 'Trying to refund what has already gone back.' });
  assert.equal(again.statusCode, 409, again.body);
  assert.equal((again.json() as { error: string }).error, 'nothing_refundable');
});

// ── The bounds, each one refusing BEFORE Stripe is called ──────────────────

test('the bounds: zero, more than is refundable, an unpaid invoice, a disputed one, and one Stripe never touched', async () => {
  const inv = await paidInvoice(10000);
  refundCalls.length = 0;

  const zero = await refund(rene, inv.id, { amountCents: 0, reason: 'A refund of nothing is not a refund.' });
  assert.equal(zero.statusCode, 400, zero.body);
  // A zod refusal travels as issues, which is what the modal renders beside the field it names.
  assert.match(issue(zero.json()), /more than zero/);

  const tooMuch = await refund(rene, inv.id, { amountCents: 10001, reason: 'More than the client ever paid on this invoice.' });
  assert.equal(tooMuch.statusCode, 409, tooMuch.body);
  assert.equal((tooMuch.json() as { error: string }).error, 'amount_too_large');
  assert.match((tooMuch.json() as { message: string }).message, /\$100\.00/, 'the refusal names the most that can go back');

  const open = await paidInvoice(10000, { status: 'sent' });
  const notPaid = await refund(rene, open.id, { amountCents: 100, reason: 'Nothing has been paid on this invoice yet.' });
  assert.equal(notPaid.statusCode, 409, notPaid.body);
  assert.match((notPaid.json() as { message: string }).message, /only a paid invoice can be refunded/);

  const noStripe = await paidInvoice(10000, { pi: false });
  const byHand = await refund(rene, noStripe.id, { amountCents: 100, reason: 'This one was paid by cheque, so Stripe has nothing to reverse.' });
  assert.equal(byHand.statusCode, 409, byHand.body);
  assert.equal((byHand.json() as { error: string }).error, 'no_payment');

  const disputed = await paidInvoice(10000);
  await app.db.query(
    `INSERT INTO invoice_refunds (invoice_id, stripe_refund_id, amount_cents, reason)
     VALUES ($1, $2, 1, 'synthetic')`, [disputed.id, `re_test_disputed_${seq}`]);
  await app.db.query(`UPDATE invoices SET status = 'disputed' WHERE id = $1`, [disputed.id]);
  const underDispute = await refund(rene, disputed.id, { amountCents: 100, reason: 'The card network is already deciding this one.' });
  assert.equal(underDispute.statusCode, 409, underDispute.body);
  assert.match((underDispute.json() as { message: string }).message, /card dispute/);

  const missing = await refund(rene, inv.id, { amountCents: 100 });
  assert.equal(missing.statusCode, 400, missing.body);
  const tooShort = await refund(rene, inv.id, { amountCents: 100, reason: 'oops' });
  assert.equal(tooShort.statusCode, 400, tooShort.body);
  assert.match(issue(tooShort.json()), /at least a few words/);
  // The reason is for the next reader, not a pointer into a conversation (2026-09-12 validator).
  const pointer = await refund(rene, inv.id, { amountCents: 100, reason: 'Refunding this per our call earlier today.' });
  assert.equal(pointer.statusCode, 400, pointer.body);
  assert.match(issue(pointer.json()), /Write the reason for whoever reads this next/);

  assert.equal(refundCalls.length, 0, 'not one refusal reached Stripe');
  assert.equal((await invoiceState(inv.id)).status, 'paid', 'and nothing moved');
});

test('a role without billing.manage cannot refund, and its own refusal moves no money', async () => {
  const inv = await paidInvoice(10000);
  refundCalls.length = 0;
  const res = await refund(bookkeeper, inv.id, { amountCents: 100, reason: 'A role proof: this refund must be refused.' });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(refundCalls.length, 0);
  assert.equal((await invoiceState(inv.id)).status, 'paid');
  assert.equal((await refundRows(inv.id)).length, 0);
});

// ── The webhook reconciling to the door's own refund ───────────────────────

test('charge.refunded for a refund the door made: the same row, one receipt, one money action', async () => {
  const inv = await paidInvoice(20000);
  await arm('refund_receipt', true);
  const made = (await refund(rene, inv.id, {
    amountCents: 5000,
    reason: 'The client was billed for a month of bookkeeping that was never started.',
  }).then((r) => r.json())) as { stripeRefundId: string };

  const w = await webhookRefund(inv, { id: made.stripeRefundId, cents: 5000 }, 5000, `evt_refundctl_reconcile_${seq}`);
  assert.equal(w.status, 'partially_refunded');
  assert.equal(w.recorded, 0, 'the refund id was already on the record');
  assert.equal(w.reconciled, 1, 'the row it found was updated, not duplicated');
  assert.equal(w.reconciledToTheDoor, true, 'and the webhook knows this refund was ours');

  const rows = await refundRows(inv.id);
  assert.equal(rows.length, 1, 'ONE refund row for one refund');
  assert.equal(rows[0]!.stripe_refund_id, made.stripeRefundId);
  assert.equal(rows[0]!.stripe_event_id, `evt_refundctl_reconcile_${seq}`, 'the row learned which event confirmed it');
  assert.equal(rows[0]!.refunded_by_staff_id, rene.id, 'and it still belongs to the person who pressed it');
  assert.equal((await invoiceState(inv.id)).amount_refunded_cents, 5000, 'not doubled');

  const receipts = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM outbox WHERE effect = 'invoice.refund_receipt' AND contact_id = $1`, [inv.contactId]);
  assert.equal(receipts.rows[0]!.n, 1, 'exactly one receipt — the client is told about a refund once');

  const reconciled = await app.db.query(
    `SELECT 1 FROM audit_log WHERE object_id = $1 AND action = 'invoice.refund_reconciled'`, [inv.id]);
  assert.equal(reconciled.rows.length, 1, 'audited as Stripe agreeing with us');
  const asRefund = await app.db.query(
    `SELECT 1 FROM audit_log WHERE object_id = $1 AND action = 'invoice.refunded'`, [inv.id]);
  assert.equal(asRefund.rows.length, 0, 'never as a second refund — that is what would double the money line');

  // A redelivery of the same event is the latch's job and changes nothing either.
  const replay = await webhookRefund(inv, { id: made.stripeRefundId, cents: 5000 }, 5000, `evt_refundctl_reconcile_${seq}`);
  assert.equal(replay.status, 'duplicate');
  assert.equal((await refundRows(inv.id)).length, 1);
});

test('the money line: a staff refund is on it once and never outside the door; the CEO\'s is on neither', async () => {
  const staffInv = await paidInvoice(20000);
  const made = (await refund(rene, staffInv.id, {
    amountCents: 7500,
    reason: 'The client paid twice for the same quarter; the second payment goes back.',
  }).then((r) => r.json())) as { stripeRefundId: string };
  await webhookRefund(staffInv, { id: made.stripeRefundId, cents: 7500 }, 7500, `evt_refundctl_money_${seq}`);

  const ceoInv = await paidInvoice(20000);
  await refund(ceo, ceoInv.id, { amountCents: 2500, reason: 'A goodwill adjustment agreed with the client on the annual review.' });

  const line = await moneyLineToday(app, todayChicago());
  const mine = line.byStaff.filter((r) => r.invoiceNumber === staffInv.number);
  assert.equal(mine.length, 1, 'one money action, not two — the webhook did not add a second');
  assert.equal(mine[0]!.action, 'Refund');
  assert.equal(mine[0]!.actorClass, 'staff');
  assert.equal(mine[0]!.actorId, rene.id);
  assert.equal(mine[0]!.amountCents, 7500);
  assert.match(mine[0]!.reason ?? '', /paid twice/);
  assert.equal(line.outsideTheDoor.filter((r) => r.invoiceNumber === staffInv.number).length, 0,
    'a refund made through the door is never money that moved outside it');

  assert.equal(line.byStaff.filter((r) => r.invoiceNumber === ceoInv.number).length, 0, 'the CEO is not reported to himself');
  assert.equal(line.outsideTheDoor.filter((r) => r.invoiceNumber === ceoInv.number).length, 0);
});

test('the send log after delivery: one outbox row for the receipt and one delivery row, so a count of receipts reads outbox rows', async () => {
  const inv = await paidInvoice(20000);
  await arm('refund_receipt', true);
  const made = (await refund(rene, inv.id, { amountCents: 5000, reason: 'The client paid for a quarter that was cancelled before it started.' }).then((r) => r.json())) as { stripeRefundId: string };
  await drainOutbox(app);
  const log = (await app.inject({ method: 'GET', url: `/invoices/${inv.id}/sends`, headers: auth(rene) })).json() as { rows: Array<{ source: string; what: string; state: string }> };
  const receipts = log.rows.filter((r) => r.source === 'outbox' && r.what.startsWith('invoice.refund_receipt'));
  const delivered = log.rows.filter((r) => r.source === 'audit' && r.what === 'invoice.refund_receipt_sent');
  assert.equal(receipts.length, 1, 'one receipt, as an outbox row');
  assert.equal(receipts[0]!.state, 'sent');
  assert.equal(delivered.length, 1, 'and its delivery, as an audit row whose name also begins invoice.refund_receipt');
  // The shape the harness assertion must respect: a substring count over the whole log reads TWO for one receipt.
  assert.equal(log.rows.filter((r) => r.what.includes('invoice.refund_receipt')).length, 2);
  assert.ok(made.stripeRefundId);
});

// ── The switch (2026-09-20) ────────────────────────────────────────────────

test('the switch is OFF by default: a box that never set OPS_REFUND_CONTROL has no Refund door', () => {
  const fresh = loadConfig({ NODE_ENV: 'test', OPS_REFUND_CONTROL: undefined });
  assert.equal(fresh.OPS_REFUND_CONTROL, 'off');
  assert.equal(config.OPS_REFUND_CONTROL, 'on', 'this spec turned it on to prove the door');
  assert.equal(app.switches.opsRefundControl, 'on', 'and the running server holds what config said');
});

test('the switch off: 409 with the sentence before the body is read, the session says off, Stripe is never asked, and a refund made in Stripe still lands on the row', async () => {
  const inv = await paidInvoice(20000);
  refundCalls.length = 0;
  app.switches.opsRefundControl = 'off';
  try {
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(rene) });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal((me.json() as { switches: { opsRefundControl: string } }).switches.opsRefundControl, 'off', 'the page reads the state from the session');

    const res = await refund(rene, inv.id, { amountCents: 5000, reason: 'The client cancelled the quarter before it started and asked for the difference back.' });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().error, 'refund_control_off');
    assert.equal(res.json().message, 'Refunds are made in Stripe and recorded here.', 'the same sentence the row shows');
    // Before the body: a body the validator would refuse is still answered by the switch, not by zod.
    const junk = await refund(rene, inv.id, { amountCents: -1 });
    assert.equal(junk.statusCode, 409, 'the closed door examines nothing about the request');
    // The switch is not a permission: the CEO is refused the same way, and the bookkeeper is still 403.
    assert.equal((await refund(ceo, inv.id, { amountCents: 5000, reason: 'A goodwill adjustment agreed with the client on the annual review.' })).statusCode, 409);
    assert.equal((await refund(bookkeeper, inv.id, { amountCents: 5000, reason: 'A goodwill adjustment agreed with the client on the annual review.' })).statusCode, 403);
    assert.equal(refundCalls.length, 0, 'Stripe was never asked');
    const untouched = await invoiceState(inv.id);
    assert.equal(untouched.status, 'paid');
    assert.equal(untouched.amount_refunded_cents, 0);

    // "Refunds are made in Stripe and recorded here": a refund SAOS has never seen, made in the
    // dashboard, arrives as charge.refunded and is recorded on the invoice — the switch does not
    // reach the webhook path.
    const out = await webhookRefund(inv, { id: `re_dashboard_${seq}`, cents: 5000 }, 5000, `evt_refundctl_off_${seq}`);
    assert.equal(out.status, 'partially_refunded');
    assert.equal(out.recorded, 1, 'a new row, because nobody at SAOS made this refund');
    assert.equal(out.reconciledToTheDoor, undefined, 'and it is not reconciled to a door that was closed');
    const rows = await refundRows(inv.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.refunded_by_staff_id, null, 'no actor: money that moved outside the door');
    assert.equal(rows[0]!.stripe_event_id, `evt_refundctl_off_${seq}`);
    const audited = await app.db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE object_type = 'invoice' AND object_id = $1 AND action IN ('invoice.refunded', 'invoice.refund_reconciled', 'invoice.refund_issued') ORDER BY occurred_at`,
      [inv.id]
    );
    assert.deepEqual(audited.rows.map((r) => r.action), ['invoice.refunded'], 'one money action, from Stripe, and no door action');
  } finally {
    app.switches.opsRefundControl = 'on';
  }
  // On again: the same invoice's remainder goes through the door, unchanged from before.
  const opened = await refund(rene, inv.id, { amountCents: 5000, reason: 'The rest of the cancelled quarter, now that the first half has been returned.' });
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(refundCalls.length, 1, 'Stripe asked once, now that the door is open');
  assert.equal((await invoiceState(inv.id)).amount_refunded_cents, 10000);
});

test('the flip lives in the harness boot alone: nothing under src registers a /harness route', () => {
  const src = resolve(here, '..', 'src');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ts$/.test(name) && /['"`]\/harness/.test(readFileSync(full, 'utf8'))) offenders.push(full);
    }
  };
  walk(src);
  assert.deepEqual(offenders, [], 'production registers no /harness route');
  const boot = readFileSync(resolve(here, '..', 'scripts', 'e2e-boot.ts'), 'utf8');
  assert.match(boot, /app\.post<\{ Body: \{ state\?: unknown \} \}>\('\/harness\/refund-control'/, 'the harness boot owns the flip');
  assert.match(boot, /process\.env\.OPS_REFUND_CONTROL = 'on'/, 'and boots with the control on for the R29 taps');
});

// ── The adapter's own two promises ─────────────────────────────────────────

test('the stub is idempotent on its key: the same press twice is ONE refund', async () => {
  const key = `saos-refund-synthetic-${seq}`;
  const first = await stripe.createRefund({ paymentIntentId: 'pi_test_idem', amountCents: 500, idempotencyKey: key });
  const second = await stripe.createRefund({ paymentIntentId: 'pi_test_idem', amountCents: 500, idempotencyKey: key });
  assert.equal(second.id, first.id, 'a repeated key is the same refund, as Stripe would answer');
  const listed = await stripe.listRefunds('ch_stub_pi_test_idem');
  assert.equal(listed.length, 1, 'and the charge holds one refund, so a later re-sync reads the truth');
});

test('live mode routes a refund at Stripe itself — untested here, and asserted to BE the live path', () => {
  const live = makeStripeAdapter({ ...config, STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_test_synthetic_not_a_real_key' });
  assert.equal(live.mode, 'live', 'STRIPE_MODE=live must not reach the stub');
  assert.equal(typeof live.createRefund, 'function');
  /*
   * No live call is made anywhere in this repository, so the only thing that can be proven at build
   * time is that the live adapter refunds through Stripe's refunds.create against the payment
   * intent with the caller's idempotency key. The first real refund is Brian's, and this is said
   * plainly in the 2026-09-20 report rather than implied by a green test.
   */
  const source = readFileSync(resolve(here, '..', 'src', 'modules', 'billing', 'stripe.ts'), 'utf8');
  const liveHalf = source.slice(source.indexOf('function liveAdapter'));
  assert.match(liveHalf, /stripe\.refunds\.create\(/, 'the live adapter calls Stripe refunds.create');
  assert.match(liveHalf, /idempotencyKey: input\.idempotencyKey/, 'with the idempotency key the door computed');
  assert.match(liveHalf, /payment_intent: input\.paymentIntentId/, 'against the payment intent, so Stripe finds the charge');
});
