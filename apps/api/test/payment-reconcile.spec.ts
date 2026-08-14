// FINDING #24 — payment reconciliation, the backstop for a webhook that never arrives.
//
// The bug this covers, exactly as it happened on 2026-08-13: a real deposit was
// paid with a test card, Stripe recorded the session paid, and the invoice sat "Open"
// forever because the webhook endpoint had vanished from the Stripe account. Nothing in
// SAOS ever asked Stripe a question — it only ever waited to be told.
//
// The stub adapter deliberately never reports a payment (a test double that answered
// "paid" would make this whole file pass while settling nothing in production), so these
// tests inject a Stripe whose answers they control. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import type { StripeAdapter } from '../src/modules/billing/stripe.ts';
import { generateToken } from '../src/crypto.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { reconcileInvoice, runPaymentReconcileJob } from '../src/modules/billing/reconcile.ts';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff & { token: string };

const sentMail: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    sentMail.push(msg);
    return { id: `captured-${sentMail.length}` };
  },
};

/**
 * A Stripe we can steer. `paid` holds the session ids Stripe considers settled;
 * `asked` records every question, so a test can prove the code actually went and
 * asked rather than assuming.
 */
const paid = new Set<string>();
const asked: string[] = [];
const fakeStripe: StripeAdapter = {
  mode: 'stub',
  async createCheckoutSession(input) {
    const sessionId = `cs_fake_${input.invoiceId}`;
    return { sessionId, url: `https://checkout.stripe.example/${sessionId}` };
  },
  async retrieveCheckoutSession(sessionId) {
    asked.push(sessionId);
    return paid.has(sessionId)
      ? { status: 'complete', paymentStatus: 'paid', paymentIntentId: `pi_fake_${sessionId}` }
      : { status: 'open', paymentStatus: 'unpaid' };
  },
  parseWebhookEvent() {
    return { type: 'ignored' };
  },
};

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function makeClient(last: string, email: string): Promise<{ contactId: string; token: string }> {
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, language, soto_status)
     VALUES ('Synthetic', $1, $2, 'en', 'active') RETURNING id`,
    [last, email]
  );
  const contactId = contact.rows[0]!.id;
  const user = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [contactId, email]
  );
  const { token, hash } = generateToken();
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '1 day')`,
    [user.rows[0]!.id, hash]
  );
  return { contactId, token };
}

/** An invoice sent to the client, priced from the book, awaiting payment. */
async function sendInvoice(contactId: string, cents: number): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/invoices', headers: auth(rene),
    payload: {
      contactId,
      send: true,
      lines: [{ description: 'Synthetic deposit', qty: 1, unitCents: cents }],
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

before(async () => {
  config = await createTestConfig('recon');
  app = buildServer(config, { mailer: capturingMailer, stripe: fakeStripe });
  await app.ready();

  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email: 'rene-recon@example.test', name: 'Synthetic Rene', role: 'comms_billing',
    password: 'recon-password-123456', totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const login = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: staff.email, password: staff.password, totp: code },
  });
  assert.equal(login.statusCode, 200, login.body);
  rene = { ...staff, token: login.json().token as string };
});

after(async () => {
  await app.close();
});

test('the exact 2026-08-13 bug: paid at Stripe, no webhook — reconcile settles it', async () => {
  const client = await makeClient('Reconone', 'recon-one@example.test');
  const invoiceId = await sendInvoice(client.contactId, 25000);

  // The client goes to Stripe...
  const checkout = await app.inject({
    method: 'POST', url: `/portal/invoices/${invoiceId}/checkout`,
    headers: { authorization: `Bearer ${client.token}` },
  });
  assert.equal(checkout.statusCode, 200, checkout.body);
  const sessionId = `cs_fake_${invoiceId}`;

  // ...and pays. Stripe knows. NO WEBHOOK IS DELIVERED — that is the whole bug.
  paid.add(sessionId);

  const beforeState = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM invoices WHERE id = $1`, [invoiceId]);
  assert.notEqual(beforeState.rows[0]!.status, 'paid', 'still open — nothing has told us');

  // The client lands back on the portal with ?paid=1 and the page asks.
  const res = await app.inject({
    method: 'POST', url: `/portal/invoices/${invoiceId}/reconcile`,
    headers: { authorization: `Bearer ${client.token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'paid');
  assert.equal(res.json().settledByReconcile, true, 'THIS call is what settled it');
  assert.ok(asked.includes(sessionId), 'it actually asked Stripe');

  const after = await app.db.query<{ status: string; paid_at: string | null; amount_paid_cents: number }>(
    `SELECT status::text AS status, paid_at, amount_paid_cents FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  assert.equal(after.rows[0]!.status, 'paid');
  assert.ok(after.rows[0]!.paid_at, 'paid_at stamped');
  assert.equal(after.rows[0]!.amount_paid_cents, 25000, 'settled for the full amount');

  // The audit trail says a webhook went missing — the thing Brian had to find by hand.
  const audit = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE object_id = $1 AND action = 'invoice.settled_by_reconcile'`,
    [invoiceId]
  );
  assert.equal(audit.rows[0]!.n, 1);
});

test('a client cannot mark their own invoice paid by calling reconcile', async () => {
  const client = await makeClient('Recontwo', 'recon-two@example.test');
  const invoiceId = await sendInvoice(client.contactId, 15000);
  await app.inject({
    method: 'POST', url: `/portal/invoices/${invoiceId}/checkout`,
    headers: { authorization: `Bearer ${client.token}` },
  });
  // Stripe is NOT told about any payment. The client hammers reconcile anyway.
  for (let i = 0; i < 3; i += 1) {
    const res = await app.inject({
      method: 'POST', url: `/portal/invoices/${invoiceId}/reconcile`,
      headers: { authorization: `Bearer ${client.token}` },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().status, 'not_paid_yet');
  }
  const state = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM invoices WHERE id = $1`, [invoiceId]);
  assert.notEqual(state.rows[0]!.status, 'paid', 'only Stripe can make it paid');
});

test("reconcile is scoped: another client's invoice does not exist to you", async () => {
  const owner = await makeClient('Reconowner', 'recon-owner@example.test');
  const stranger = await makeClient('Reconstranger', 'recon-stranger@example.test');
  const invoiceId = await sendInvoice(owner.contactId, 9900);
  await app.inject({
    method: 'POST', url: `/portal/invoices/${invoiceId}/checkout`,
    headers: { authorization: `Bearer ${owner.token}` },
  });
  paid.add(`cs_fake_${invoiceId}`); // genuinely paid — the stranger still gets nothing

  const res = await app.inject({
    method: 'POST', url: `/portal/invoices/${invoiceId}/reconcile`,
    headers: { authorization: `Bearer ${stranger.token}` },
  });
  assert.equal(res.statusCode, 404, 'not "403 forbidden" — it does not exist to them');

  const state = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM invoices WHERE id = $1`, [invoiceId]);
  assert.notEqual(state.rows[0]!.status, 'paid', "the stranger's call settled nothing");
});

test('idempotent: reconciling twice does not double-settle or re-audit', async () => {
  const client = await makeClient('Reconidem', 'recon-idem@example.test');
  const invoiceId = await sendInvoice(client.contactId, 12500);
  await app.inject({
    method: 'POST', url: `/portal/invoices/${invoiceId}/checkout`,
    headers: { authorization: `Bearer ${client.token}` },
  });
  paid.add(`cs_fake_${invoiceId}`);

  const first = await reconcileInvoice(app, invoiceId);
  assert.equal(first.status, 'paid');
  assert.equal(first.settledByReconcile, true);

  const second = await reconcileInvoice(app, invoiceId);
  assert.equal(second.status, 'already_paid');
  assert.equal(second.settledByReconcile, false, 'the second call did not re-settle');

  const audit = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log
      WHERE object_id = $1 AND action = 'invoice.settled_by_reconcile'`,
    [invoiceId]
  );
  assert.equal(audit.rows[0]!.n, 1, 'settled once, audited once');
});

test('an invoice that never went to checkout has nothing to reconcile', async () => {
  const client = await makeClient('Reconnosess', 'recon-nosess@example.test');
  const invoiceId = await sendInvoice(client.contactId, 5000);
  const res = await reconcileInvoice(app, invoiceId);
  assert.equal(res.status, 'no_session');
  assert.equal(res.settledByReconcile, false);
});

test('the sweep catches the client who paid and closed the tab', async () => {
  const client = await makeClient('Reconsweep', 'recon-sweep@example.test');
  const invoiceId = await sendInvoice(client.contactId, 40000);
  await app.inject({
    method: 'POST', url: `/portal/invoices/${invoiceId}/checkout`,
    headers: { authorization: `Bearer ${client.token}` },
  });
  paid.add(`cs_fake_${invoiceId}`);

  // Inside the grace window the sweep leaves it alone: a webhook usually lands in
  // seconds, and chasing a payment still in flight is wasted work, not a fix.
  const early = await runPaymentReconcileJob(app, { graceMinutes: 60 });
  const stillOpen = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM invoices WHERE id = $1`, [invoiceId]);
  assert.notEqual(stillOpen.rows[0]!.status, 'paid', `grace window respected (checked ${early.checked})`);

  // Past the window, nobody had to notice: the sweep settles it.
  const sweep = await runPaymentReconcileJob(app, { graceMinutes: 0 });
  assert.ok(sweep.settled >= 1, 'the sweep settled it');

  const settled = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM invoices WHERE id = $1`, [invoiceId]);
  assert.equal(settled.rows[0]!.status, 'paid');
});

test('one unreachable session does not stop the sweep for everyone else', async () => {
  const a = await makeClient('Reconfail', 'recon-fail@example.test');
  const b = await makeClient('Reconok', 'recon-ok@example.test');
  const failing = await sendInvoice(a.contactId, 7700);
  const good = await sendInvoice(b.contactId, 8800);
  for (const [client, id] of [[a, failing], [b, good]] as const) {
    await app.inject({
      method: 'POST', url: `/portal/invoices/${id}/checkout`,
      headers: { authorization: `Bearer ${client.token}` },
    });
  }
  paid.add(`cs_fake_${good}`);

  // Make Stripe throw for exactly one session — a network blip, a deleted session.
  const realRetrieve = fakeStripe.retrieveCheckoutSession.bind(fakeStripe);
  fakeStripe.retrieveCheckoutSession = async (sessionId: string) => {
    if (sessionId === `cs_fake_${failing}`) throw new Error('synthetic Stripe outage');
    return realRetrieve(sessionId);
  };
  try {
    const sweep = await runPaymentReconcileJob(app, { graceMinutes: 0 });
    assert.ok(sweep.errors >= 1, 'the failure was counted, not swallowed');
    assert.ok(sweep.settled >= 1, 'and the healthy invoice still settled');
  } finally {
    fakeStripe.retrieveCheckoutSession = realRetrieve;
  }

  const settled = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM invoices WHERE id = $1`, [good]);
  assert.equal(settled.rows[0]!.status, 'paid');
});
