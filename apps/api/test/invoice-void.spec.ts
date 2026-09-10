// THE VOID PATH (2026-09-09, Brian's ruling).
//
// Only a sent or overdue invoice can be voided; a paid one is refunded, never voided; a
// reason is required; the actor is recorded; void is terminal. The rule lives in the
// DATABASE (migration 0081), so these tests push on it with raw SQL as well as through the
// route — a rule that only the handler enforces is a convention.
//
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import type { StripeAdapter } from '../src/modules/billing/stripe.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { drainOutbox } from '../src/outbox.ts';
import { runReport } from '../src/modules/reports/service.ts';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff & { token: string };
let intern: TestStaff & { token: string };

const sentMail: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    sentMail.push(msg);
    return { id: `captured-${sentMail.length}` };
  },
};

/** A Stripe that remembers which sessions it was asked to expire. */
const expired: string[] = [];
const fakeStripe: StripeAdapter = {
  mode: 'stub',
  keyMode: null,
  async retrieveCharge() { return null; },
  async createCheckoutSession(input) {
    const sessionId = `cs_fake_${input.invoiceId}`;
    return { sessionId, url: `https://checkout.stripe.example/${sessionId}` };
  },
  async retrieveCheckoutSession() {
    return { status: 'open', paymentStatus: 'unpaid' };
  },
  parseWebhookEvent(headers, rawBody, sharedSecret) {
    if (headers['x-webhook-secret'] !== sharedSecret) throw new Error('bad secret');
    const body = JSON.parse(rawBody.toString('utf8')) as { id?: string; data?: { object?: { id?: string; payment_intent?: string; metadata?: { invoice_id?: string } } } };
    return {
      type: 'payment_completed',
      eventId: body.id ?? '',
      invoiceId: body.data?.object?.metadata?.invoice_id,
      checkoutSessionId: body.data?.object?.id,
      paymentIntentId: body.data?.object?.payment_intent,
    };
  },
  async listRefunds() {
    return [];
  },
  async expireCheckoutSession(sessionId) {
    expired.push(sessionId);
  },
};

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
async function invoice(status: 'sent' | 'overdue' | 'paid' | 'draft', cents = 20000, session: string | null = null) {
  seq += 1;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Void${seq}`, email: `void-${seq}@example.test` });
  const number = `SV-2026-${String(seq).padStart(4, '0')}`;
  const paid = status === 'paid' ? cents : 0;
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents,
                           sent_at, paid_at, stripe_checkout_session_id)
     VALUES ($1, $2, $3::invoice_status, $4, $4, $5,
             CASE WHEN $3 = 'draft' THEN NULL ELSE now() - interval '2 days' END,
             CASE WHEN $3 = 'paid' THEN now() ELSE NULL END, $6) RETURNING id`,
    [number, c.id, status, cents, paid, session]
  );
  return { id: rows[0]!.id, number, contactId: c.id, email: `void-${seq}@example.test` };
}

async function state(id: string) {
  const { rows } = await app.db.query<{ status: string; void_reason: string | null; voided_by_staff_id: string | null; voided_at: Date | null; invoice_number: string; session: string | null }>(
    `SELECT status::text AS status, void_reason, voided_by_staff_id, voided_at, invoice_number, stripe_checkout_session_id AS session FROM invoices WHERE id = $1`, [id]);
  return rows[0]!;
}

before(async () => {
  config = await createTestConfig('invoicevoid');
  app = buildServer(config, { mailer: capturingMailer, stripe: fakeStripe });
  await app.ready();
  rene = await staffWithToken('rene-void@example.test', 'comms_billing');
  intern = await staffWithToken('intern-void@example.test', 'intern');
});

after(async () => {
  await app.close();
});

test('the billing role voids a sent invoice: reason and actor recorded, session expired, client told, number kept', async () => {
  const inv = await invoice('sent', 20000, 'cs_fake_open_session');
  sentMail.length = 0;
  const res = await app.inject({
    method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(rene),
    payload: { reason: 'Superseded by a smaller deposit invoice' },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().invoiceNumber, inv.number);
  assert.equal(res.json().expiredSession, 'cs_fake_open_session');

  const s = await state(inv.id);
  assert.equal(s.status, 'void');
  assert.equal(s.void_reason, 'Superseded by a smaller deposit invoice');
  assert.equal(s.voided_by_staff_id, rene.id, 'the actor is on the row, not just the audit');
  assert.ok(s.voided_at);
  assert.equal(s.invoice_number, inv.number, 'the number is retained');
  assert.equal(s.session, null, 'no live session is left on it');
  assert.ok(expired.includes('cs_fake_open_session'), 'Stripe was asked to expire the open session');

  const audit = await app.db.query<{ actor_label: string; details: { reason: string } }>(
    `SELECT actor_label, details FROM audit_log WHERE object_id = $1 AND action = 'invoice.voided'`, [inv.id]);
  assert.equal(audit.rows.length, 1);
  // Item 11 (2026-09-09): the actor is a NAME, never an email — inverted from the email premise.
  assert.equal(audit.rows[0]!.actor_label, 'Synthetic comms_billing');
  assert.doesNotMatch(audit.rows[0]!.actor_label, /@/);

  // The client is told through the outbox, not during the request.
  assert.equal(sentMail.filter((m) => m.to === inv.email).length, 0, 'nothing sent inside the request');
  await drainOutbox(app);
  const notice = sentMail.find((m) => m.to === inv.email);
  assert.ok(notice, 'the client was told their pay link is dead');
  assert.match(notice!.subject, /cancelled/i);
  assert.match(notice!.subject, new RegExp(inv.number));
});

test('a paid invoice cannot be voided — refused by the route, and by the database on a raw UPDATE', async () => {
  const inv = await invoice('paid');
  const res = await app.inject({
    method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(rene), payload: { reason: 'Trying anyway' },
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.json().message, /refunded, not voided/);

  await assert.rejects(
    app.db.query(`UPDATE invoices SET status = 'void', void_reason = 'sql says so' WHERE id = $1`, [inv.id]),
    (err: { message: string }) => /paid invoice is refunded, not voided/.test(err.message),
    'the rule is in the database, not the handler'
  );
  assert.equal((await state(inv.id)).status, 'paid');
});

test('a reason is required — by the route and by the database', async () => {
  const inv = await invoice('overdue');
  const res = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(rene), payload: { reason: '  ' } });
  assert.equal(res.statusCode, 400, res.body);
  await assert.rejects(
    app.db.query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [inv.id]),
    (err: { message: string }) => /requires a reason/.test(err.message)
  );
  assert.equal((await state(inv.id)).status, 'overdue');
});

test('void is terminal: nothing moves an invoice out of it, not even SQL', async () => {
  const inv = await invoice('sent');
  await app.inject({ method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(rene), payload: { reason: 'Duplicate of another invoice' } });
  await assert.rejects(
    app.db.query(`UPDATE invoices SET status = 'sent' WHERE id = $1`, [inv.id]),
    (err: { message: string }) => /void is terminal/.test(err.message)
  );
  await assert.rejects(
    app.db.query(`UPDATE invoices SET status = 'paid', amount_paid_cents = total_cents WHERE id = $1`, [inv.id]),
    (err: { message: string }) => /void is terminal/.test(err.message)
  );
});

test('a draft cannot be voided (only sent or overdue), and the database says so', async () => {
  const inv = await invoice('draft');
  const res = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(rene), payload: { reason: 'Never sent, wanted gone' } });
  assert.equal(res.statusCode, 409, res.body);
  await assert.rejects(
    app.db.query(`UPDATE invoices SET status = 'void', void_reason = 'x' WHERE id = $1`, [inv.id]),
    (err: { message: string }) => /only a sent or overdue invoice/.test(err.message)
  );
});

test('a role without billing.manage cannot void', async () => {
  const inv = await invoice('sent');
  const res = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(intern), payload: { reason: 'I would like this gone' } });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal((await state(inv.id)).status, 'sent');
});

test('a payment that lands on a VOID invoice does not flip it — a task is raised for a person', async () => {
  const inv = await invoice('sent', 20000, 'cs_fake_late');
  await app.inject({ method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(rene), payload: { reason: 'Superseded before payment' } });
  const hook = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET, 'content-type': 'application/json' },
    payload: JSON.stringify({ id: 'evt_test_late_pay', type: 'checkout.session.completed',
      data: { object: { id: 'cs_fake_late', payment_intent: 'pi_test_late', metadata: { invoice_id: inv.id } } } }),
  });
  assert.equal(hook.statusCode, 200, hook.body);
  assert.equal(hook.json().refused, 'void');
  assert.equal((await state(inv.id)).status, 'void', 'void is terminal even for money');
  const task = await app.db.query<{ title: string }>(
    `SELECT title FROM tasks WHERE source_type = 'stripe_unmatched' AND source_id = 'pi_test_late'`);
  assert.equal(task.rows.length, 1, 'a person is told');
  assert.match(task.rows[0]!.title, /VOID invoice/);
});

test('a void invoice leaves A/R aging and the number is not reused', async () => {
  const inv = await invoice('overdue', 33300);
  const before = await runReport(app, 'ar_aging', { from: '2026-01-01', to: '2026-12-31' });
  const owedBefore = before.rows.reduce((n, r) => n + Number((r as { owed_cents: number }).owed_cents), 0);
  assert.ok(owedBefore >= 33300, 'it is in aging while overdue');

  await app.inject({ method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(rene), payload: { reason: 'Client was never engaged for this' } });
  const after_ = await runReport(app, 'ar_aging', { from: '2026-01-01', to: '2026-12-31' });
  const owedAfter = after_.rows.reduce((n, r) => n + Number((r as { owed_cents: number }).owed_cents), 0);
  assert.equal(owedAfter, owedBefore - 33300, 'void is out of A/R');

  const numbers = await app.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM invoices WHERE invoice_number = $1`, [inv.number]);
  assert.equal(numbers.rows[0]!.n, 1, 'the number stays with the void invoice — never reissued');
});
