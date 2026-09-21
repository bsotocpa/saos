/*
 * THE REAL REFUND CALL, PROVEN IN STRIPE TEST MODE (2026-09-20).
 *
 * The Ops Refund control creates a refund AT Stripe through the live adapter's refunds.create — a
 * call nothing in this repository had ever made against Stripe's real API. Until it is proven, the
 * control ships OFF (OPS_REFUND_CONTROL). This spec is the proof, and it runs ONLY against Stripe's
 * TEST mode, where no money exists:
 *
 *   a payment        two PaymentIntents confirmed with Stripe's own test card token (pm_card_visa),
 *                    each linked to a paid invoice row in this spec's own database;
 *   a full refund    invoice A: one refund for the whole payment, through the Ops door and so
 *                    through the adapter's createRefund;
 *   a partial refund invoice B: a partial refund, then the remainder — the same door, twice;
 *   the webhook      Stripe's own charge.refunded events, fetched from the Events API, signed the
 *                    way Stripe signs them (t=<ts>,v1=<HMAC-SHA256 of "<ts>.<payload>"> with the
 *                    endpoint's signing secret) and posted to /webhooks/stripe, where the LIVE
 *                    adapter's constructEvent verifies them: each reconciles to the row the door
 *                    already wrote, no second row, no second receipt, and the CEO's money line
 *                    counts each refund once, against the person. A replay changes nothing. A
 *                    forged signature is refused 401.
 *
 * SKIPPED, HONESTLY, without a test-mode key. It reads STRIPE_TEST_SECRET_KEY (must start with
 * sk_test_) and STRIPE_TEST_WEBHOOK_SECRET, and NEVER STRIPE_SECRET_KEY (the live key): the config
 * this spec builds sets the Stripe key explicitly from the test variable, so nothing in .env can
 * substitute the live one. When either variable is missing the tests skip and the evidence table
 * (tasks/reports/2026-09-20-stripe-refund-test-mode.md) carries one row saying so.
 *
 * No key, token or secret value is ever printed: the log rows are checked for both values before
 * the table is written. Synthetic data only. Test mode moves no money.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import type { RefundRequest, StripeAdapter } from '../src/modules/billing/stripe.ts';
import { makeStripeAdapter } from '../src/modules/billing/stripe.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { moneyLineToday } from '../src/modules/billing/money-digest.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const DATE = '2026-09-20';
const TABLE = 'stripe-refund-test-mode';

// Read by NAME, checked by PREFIX, never printed.
const TEST_KEY = process.env.STRIPE_TEST_SECRET_KEY ?? '';
const TEST_WEBHOOK_SECRET = process.env.STRIPE_TEST_WEBHOOK_SECRET ?? '';
const keyIsTest = TEST_KEY.startsWith('sk_test_');
const enabled = keyIsTest && TEST_WEBHOOK_SECRET.length > 0;
const skipReason = !TEST_KEY
  ? 'STRIPE_TEST_SECRET_KEY not set'
  : !keyIsTest
    ? 'STRIPE_TEST_SECRET_KEY does not start with sk_test_ (only a test-mode key may run this proof)'
    : 'STRIPE_TEST_WEBHOOK_SECRET not set';

// Synthetic amounts for a test-mode charge (a test file: not a price, and no client is billed).
const FULL_CENTS = 2000;
const PART_CENTS = 750;

/** The ` | ` log the evidence table is read from: one row per step, in the order it happened. */
const log: string[][] = [];
const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const row = (step: string, what: string, result: string) => log.push([step, what, result].map(cell));

let app: FastifyInstance | null = null;
let config: Config;
let stripe: Stripe;
let rene: TestStaff & { token: string };
const refundCalls: RefundRequest[] = [];

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'test-mode' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app!.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app!.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

/** THE PAYMENT: a PaymentIntent confirmed with Stripe's test card token, then a paid invoice row on it. */
async function payment(tag: string, cents: number) {
  const pi = await stripe.paymentIntents.create({
    amount: cents,
    currency: 'usd',
    payment_method: 'pm_card_visa',
    confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    description: `SAOS refund proof, synthetic ${tag}`,
  });
  assert.equal(pi.status, 'succeeded', `the test-mode payment ${tag} settled`);
  const c = await makeContact(app!.db, { firstName: 'Synthetic', lastName: `Testmode${tag}`, email: `testmode-${tag.toLowerCase()}@example.test` });
  const number = `ST-2026-${tag}`;
  const { rows } = await app!.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents,
                           sent_at, paid_at, stripe_payment_intent_id)
     VALUES ($1, $2, 'paid'::invoice_status, $3, $3, $3, now() - interval '2 days', now() - interval '1 day', $4)
     RETURNING id`,
    [number, c.id, cents, pi.id]
  );
  row('payment', `PaymentIntent ${pi.id} for ${cents} cents with pm_card_visa, linked to invoice ${number}`, pi.status);
  return { id: rows[0]!.id, number, pi: pi.id };
}

/** THROUGH THE DOOR, and so through the adapter: POST /invoices/:id/refund. */
async function refundThroughTheDoor(inv: { id: string; number: string }, cents: number, reason: string) {
  const before = refundCalls.length;
  const res = await app!.inject({ method: 'POST', url: `/invoices/${inv.id}/refund`, headers: auth(rene), payload: { amountCents: cents, reason } });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { status: string; stripeRefundId: string; amountCents: number; amountRefundedCents: number };
  assert.equal(refundCalls.length, before + 1, 'the adapter was asked exactly once');
  assert.match(body.stripeRefundId, /^re_/, 'a Stripe refund id');
  assert.doesNotMatch(body.stripeRefundId, /^re_stub_/, 'and not the stub\'s');
  // Stripe's own record of it.
  const atStripe = await stripe.refunds.retrieve(body.stripeRefundId);
  assert.equal(atStripe.amount, cents);
  assert.equal(atStripe.status, 'succeeded');
  row('refund', `${inv.number}: ${cents} cents through POST /invoices/:id/refund → adapter createRefund → ${body.stripeRefundId}`, `${body.status}; Stripe says ${atStripe.status} for ${atStripe.amount}`);
  return body;
}

/** Stripe's signature over the exact bytes posted, computed the way Stripe computes it. */
function sign(payload: string, secret: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

async function postSigned(event: Stripe.Event, secret = TEST_WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const res = await app!.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'stripe-signature': sign(payload, secret), 'content-type': 'application/json' },
    payload,
  });
  return { status: res.statusCode, body: res.json() as { status: string; recorded?: number; reconciled?: number; reconciledToTheDoor?: boolean; message?: string } };
}

/** The charge.refunded events Stripe produced for these payment intents, oldest first. */
async function refundedEventsFor(pis: string[], expected: number): Promise<Stripe.Event[]> {
  const until = Date.now() + 90_000;
  for (;;) {
    const page = await stripe.events.list({ type: 'charge.refunded', limit: 100 });
    const mine = page.data.filter((e) => pis.includes(String((e.data.object as { payment_intent?: unknown }).payment_intent ?? '')));
    if (mine.length >= expected) {
      return mine.sort((a, b) => a.created - b.created
        || (a.data.object as { amount_refunded: number }).amount_refunded - (b.data.object as { amount_refunded: number }).amount_refunded);
    }
    if (Date.now() > until) throw new Error(`Stripe listed ${mine.length} charge.refunded event(s) for the proof's payments; ${expected} expected`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function invoiceState(id: string) {
  const { rows } = await app!.db.query<{ status: string; amount_refunded_cents: number }>(`SELECT status::text AS status, amount_refunded_cents FROM invoices WHERE id = $1`, [id]);
  return rows[0]!;
}
async function refundRows(id: string) {
  const { rows } = await app!.db.query<{ stripe_refund_id: string; amount_cents: number; stripe_event_id: string | null; refunded_by_staff_id: string | null }>(
    `SELECT stripe_refund_id, amount_cents, stripe_event_id, refunded_by_staff_id FROM invoice_refunds WHERE invoice_id = $1 ORDER BY created_at, id`, [id]);
  return rows;
}
async function receiptsFor(id: string) {
  const { rows } = await app!.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbox WHERE effect = 'invoice.refund_receipt' AND payload->>'invoiceId' = $1`, [id]);
  return rows[0]!.n;
}
async function auditActions(id: string) {
  const { rows } = await app!.db.query<{ action: string }>(
    `SELECT action FROM audit_log WHERE object_type = 'invoice' AND object_id = $1 AND action IN ('invoice.refunded', 'invoice.refund_reconciled', 'invoice.refund_issued') ORDER BY occurred_at, id`, [id]);
  return rows.map((r) => r.action);
}

test('the proof: a payment, a full refund and a partial refund through the adapter, the webhook reconciling to the same row, counted once', { skip: enabled ? false : skipReason }, async () => {
  config = {
    ...(await createTestConfig('striperefundlive')),
    STRIPE_MODE: 'live',
    STRIPE_SECRET_KEY: TEST_KEY,           // the TEST key, by name — never STRIPE_SECRET_KEY
    STRIPE_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
    OPS_REFUND_CONTROL: 'on',
  };
  assert.ok(config.STRIPE_SECRET_KEY?.startsWith('sk_test_'), 'the adapter under proof holds a test-mode key');
  const real = makeStripeAdapter(config);
  assert.equal(real.mode, 'live', 'the LIVE adapter, against the test-mode API');
  assert.equal(real.keyMode, 'test', 'on a test-mode key');
  const counted: StripeAdapter = { ...real, async createRefund(input) { refundCalls.push(input); return real.createRefund(input); } };
  app = buildServer(config, { mailer: silentMailer, stripe: counted });
  await app.ready();
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'refund_receipt'`); // as it ships
  stripe = new Stripe(TEST_KEY);
  rene = await staffWithToken('rene-testmode@example.test', 'comms_billing');
  row('adapter', 'makeStripeAdapter with STRIPE_MODE=live and the key from STRIPE_TEST_SECRET_KEY', `mode=${real.mode}, keyMode=${real.keyMode}`);

  // THE PAYMENTS.
  const a = await payment('A', FULL_CENTS);
  const b = await payment('B', FULL_CENTS);

  // THE FULL REFUND (A) and THE PARTIAL, THEN THE REMAINDER (B), all through the door.
  const fullA = await refundThroughTheDoor(a, FULL_CENTS, 'The client paid for a service that was never started; the whole payment goes back.');
  assert.equal(fullA.status, 'refunded');
  const partB = await refundThroughTheDoor(b, PART_CENTS, 'The client was billed for a month of bookkeeping that never started.');
  assert.equal(partB.status, 'partially_refunded');
  const restB = await refundThroughTheDoor(b, FULL_CENTS - PART_CENTS, 'The rest of the cancelled engagement, now that the first part has been returned.');
  assert.equal(restB.status, 'refunded');
  assert.equal(refundCalls.length, 3, 'three refunds, three adapter calls');

  // What Stripe holds now, read back through the adapter's own charge read.
  const chargeA = await real.retrieveCharge(a.pi);
  const chargeB = await real.retrieveCharge(b.pi);
  assert.equal(chargeA?.amountRefundedCents, FULL_CENTS);
  assert.equal(chargeA?.refunded, true);
  assert.equal(chargeB?.amountRefundedCents, FULL_CENTS);
  assert.equal(chargeB?.refunds.length, 2);
  row('charge', 'retrieveCharge for A and B after the refunds', `A refunded=${chargeA?.refunded} ${chargeA?.amountRefundedCents}; B refunds=${chargeB?.refunds.length} ${chargeB?.amountRefundedCents}`);

  // Before the webhook: the door's rows, one receipt each, and the door's audit lines only.
  assert.equal((await refundRows(a.id)).length, 1);
  assert.equal((await refundRows(b.id)).length, 2);
  assert.equal(await receiptsFor(a.id), 1);
  assert.equal(await receiptsFor(b.id), 2);

  // THE WEBHOOK: Stripe's own events, signed the way Stripe signs them, verified by the live adapter.
  const events = await refundedEventsFor([a.pi, b.pi], 3);
  row('events', `Stripe Events API listed charge.refunded for the two payments`, `${events.length} event(s): ${events.map((e) => e.id).join(', ')}`);
  for (const e of events) {
    const pi = String((e.data.object as { payment_intent?: unknown }).payment_intent);
    const inv = pi === a.pi ? a : b;
    const out = await postSigned(e);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.recorded, 0, `${e.id}: no new row — the door already made every refund on it`);
    assert.ok((out.body.reconciled ?? 0) >= 1, `${e.id}: the existing row(s) updated in place`);
    assert.equal(out.body.reconciledToTheDoor, true, `${e.id}: the webhook knows the refund was ours`);
    row('webhook', `${e.id} (${inv.number}) signed with STRIPE_TEST_WEBHOOK_SECRET, POST /webhooks/stripe`, `${out.body.status}; recorded ${out.body.recorded}, reconciled ${out.body.reconciled}, reconciledToTheDoor ${out.body.reconciledToTheDoor}`);
  }

  // AFTER: the same rows, now carrying the event that confirmed them; nothing doubled.
  for (const inv of [a, b]) {
    const state = await invoiceState(inv.id);
    assert.equal(state.status, 'refunded');
    assert.equal(state.amount_refunded_cents, FULL_CENTS, `${inv.number}: the amount did not double`);
    const rows = await refundRows(inv.id);
    assert.equal(rows.length, inv === a ? 1 : 2, `${inv.number}: the same row(s)`);
    for (const r of rows) {
      assert.ok(r.refunded_by_staff_id, 'still the person who pressed it');
      assert.ok(r.stripe_event_id, 'and now the Stripe event that confirmed it');
    }
    assert.equal(await receiptsFor(inv.id), rows.length, `${inv.number}: one receipt per refund, none added by the webhook`);
    const actions = await auditActions(inv.id);
    assert.equal(actions.filter((x) => x === 'invoice.refund_issued').length, rows.length, 'one door action per refund');
    assert.equal(actions.filter((x) => x === 'invoice.refunded').length, 0, 'no webhook money action: the money was counted at the door');
    assert.ok(actions.filter((x) => x === 'invoice.refund_reconciled').length >= 1, 'the webhook audited a reconciliation');
    row('row', `${inv.number} after the webhook`, `${state.status}, ${state.amount_refunded_cents} cents, ${rows.length} refund row(s) with actor and event, ${await receiptsFor(inv.id)} receipt(s), audit ${actions.join('+')}`);
  }

  // COUNTED ONCE: the money line has each refund once, against the person, and nothing outside the door.
  const line = await moneyLineToday(app, todayChicago());
  const mineA = line.byStaff.filter((r) => r.invoiceNumber === a.number);
  const mineB = line.byStaff.filter((r) => r.invoiceNumber === b.number);
  assert.equal(mineA.length, 1);
  assert.equal(mineB.length, 2);
  assert.deepEqual([...mineA, ...mineB].map((r) => r.actorId), [rene.id, rene.id, rene.id]);
  assert.deepEqual(mineB.map((r) => r.amountCents ?? 0).sort((x, y) => x - y), [PART_CENTS, FULL_CENTS - PART_CENTS].sort((x, y) => x - y));
  assert.equal(line.outsideTheDoor.filter((r) => r.invoiceNumber === a.number || r.invoiceNumber === b.number).length, 0);
  row('money line', 'moneyLineToday after the webhook', `byStaff A=${mineA.length} B=${mineB.length}, outsideTheDoor 0`);

  // A REPLAY changes nothing: the latch on the event id.
  const replay = await postSigned(events[events.length - 1]!);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.status, 'duplicate');
  assert.equal((await invoiceState(b.id)).amount_refunded_cents, FULL_CENTS);
  assert.equal((await refundRows(b.id)).length, 2);
  assert.equal(await receiptsFor(b.id), 2);
  row('replay', `${events[events.length - 1]!.id} posted a second time`, `${replay.body.status}; rows, amount and receipts unchanged`);

  // A FORGED signature is refused by the live adapter's verification.
  const forged = await postSigned(events[0]!, 'whsec_synthetic_not_the_secret');
  assert.equal(forged.status, 401);
  row('forgery', `${events[0]!.id} signed with a wrong secret`, `${forged.status} ${forged.body.message ?? ''}`);
});

test('the evidence table is written from the log, skipped or not', () => {
  if (log.length === 0) row(`skipped: ${skipReason}`, 'the proof is blocked on a Stripe test-mode key and its webhook signing secret, set by name as STRIPE_TEST_SECRET_KEY and STRIPE_TEST_WEBHOOK_SECRET', 'not run');
  // No secret value reaches the file, whatever a Stripe object happened to carry.
  for (const r of log) for (const c of r) {
    if (TEST_KEY && c.includes(TEST_KEY)) throw new Error('a log cell carries the test key');
    if (TEST_WEBHOOK_SECRET && c.includes(TEST_WEBHOOK_SECRET)) throw new Error('a log cell carries the webhook secret');
  }
  const dir = join(tmpdir(), 'saos-test-evidence');
  mkdirSync(dir, { recursive: true });
  const logFile = join(dir, `${TABLE}.log`);
  writeFileSync(logFile, ['step | what | result', ...log.map((r) => r.join(' | '))].join('\n') + '\n');
  const r = spawnSync(process.execPath, [
    resolve(root, 'scripts', 'report-table.mjs'),
    '--name', TABLE, '--from-log', logFile, '--date', DATE,
    '--sql', 'cd apps/api && node --test test/stripe-refund-live.spec.ts  (Stripe TEST mode; the key and signing secret read by name from STRIPE_TEST_SECRET_KEY and STRIPE_TEST_WEBHOOK_SECRET, never STRIPE_SECRET_KEY)',
    '--note', enabled
      ? 'The Ops refund door against Stripe\'s real test-mode API: two test-card payments, one full refund and one partial-then-remainder through the adapter, Stripe\'s own charge.refunded events signed and posted to the webhook, each reconciled to the door\'s row and counted once on the money line; a replay is a duplicate and a forgery is refused.'
      : 'The proof did not run: it needs a Stripe test-mode key and the test endpoint\'s signing secret, supplied by name as STRIPE_TEST_SECRET_KEY (sk_test_…) and STRIPE_TEST_WEBHOOK_SECRET. Until it runs, OPS_REFUND_CONTROL stays off in production.',
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `report-table.mjs: ${r.stdout}${r.stderr}`);
});

after(async () => {
  if (app) await app.close();
});
