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
/** Session ids Stripe answers "No such checkout.session" for — the other world's objects. */
const missing = new Set<string>();
const asked: string[] = [];
/** The last checkout created, so a test can read the return URL Stripe was given. */
let lastCheckout: { successUrl: string; cancelUrl: string } | null = null;
// Read through a typed function: inside a test, TS narrows the let to the null it was
// just assigned and cannot see the fake assign it during the request.
function lastCheckoutSeen(): { successUrl: string; cancelUrl: string } | null { return lastCheckout; }
const fakeStripe: StripeAdapter = {
  mode: 'stub',
  // This fake holds a LIVE key: sessions it mints are cs_fake_ (mode unknown, so the
  // prefix rule stays out of the way), and a cs_test_ session stored on an invoice is
  // from the other world.
  keyMode: 'live',
  async createCheckoutSession(input) {
    const sessionId = `cs_fake_${input.invoiceId}`;
    lastCheckout = { successUrl: input.successUrl, cancelUrl: input.cancelUrl };
    return { sessionId, url: `https://checkout.stripe.example/${sessionId}` };
  },
  async retrieveCheckoutSession(sessionId) {
    asked.push(sessionId);
    if (missing.has(sessionId)) {
      // Shaped like Stripe's own error: code + statusCode are what the code reads.
      throw Object.assign(new Error(`No such checkout.session: ${sessionId}`), {
        code: 'resource_missing', statusCode: 404, type: 'StripeInvalidRequestError',
      });
    }
    return paid.has(sessionId)
      ? { status: 'complete', paymentStatus: 'paid', paymentIntentId: `pi_fake_${sessionId}` }
      : { status: 'open', paymentStatus: 'unpaid' };
  },
  parseWebhookEvent() {
    return { type: 'ignored' };
  },
  async listRefunds() {
    return [];
  },
  async expireCheckoutSession() {},
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


// ── STALE SESSIONS (2026-09-09) ────────────────────────────────────────────

/*
 * When the live key was installed, two open invoices still carried sessions minted under
 * the test key. Stripe test and live are separate worlds: the live key gets 404 for a test
 * session, forever. The sweep logged that as an error every fifteen minutes, and the portal,
 * asked on return to confirm a payment, hit the same 404 and told a client whose invoice was
 * already Paid that there was no confirmation. A session from the other world is stale:
 * retire it once, audited, and let the client's next Pay mint a fresh one.
 */

test('a session from the other Stripe world is retired by prefix, without asking Stripe', async () => {
  const client = await makeClient('Staleprefix', 'stale-prefix@example.test');
  const invoiceId = await sendInvoice(client.contactId, 20000);
  // Minted under a test key, before the live key was installed.
  await app.db.query(`UPDATE invoices SET stripe_checkout_session_id = 'cs_test_synthetic_other_world' WHERE id = $1`, [invoiceId]);
  asked.length = 0;

  const res = await reconcileInvoice(app, invoiceId);
  assert.equal(res.status, 'stale_session');
  assert.equal(res.settledByReconcile, false);
  assert.ok(!asked.includes('cs_test_synthetic_other_world'), 'the prefix answered it — Stripe was not asked');

  const row = await app.db.query<{ status: string; session: string | null }>(
    `SELECT status::text AS status, stripe_checkout_session_id AS session FROM invoices WHERE id = $1`, [invoiceId]);
  assert.equal(row.rows[0]!.status, 'sent', 'still unpaid — retiring a session is not a payment');
  assert.equal(row.rows[0]!.session, null, 'the stale session is cleared so the sweep stops asking');

  const audit = await app.db.query<{ details: { session: string; reason: string } }>(
    `SELECT details FROM audit_log WHERE object_id = $1 AND action = 'invoice.checkout_session_stale'`, [invoiceId]);
  assert.equal(audit.rows.length, 1, 'retired once, on the record');
  assert.equal(audit.rows[0]!.details.session, 'cs_test_synthetic_other_world');
  assert.match(audit.rows[0]!.details.reason, /test-mode/);
});

test('a session Stripe says does not exist is retired the same way, and the sweep counts it instead of erroring', async () => {
  const client = await makeClient('Stalemissing', 'stale-missing@example.test');
  const invoiceId = await sendInvoice(client.contactId, 20000);
  const checkout = await app.inject({
    method: 'POST', url: `/portal/invoices/${invoiceId}/checkout`,
    headers: { authorization: `Bearer ${client.token}` },
  });
  assert.equal(checkout.statusCode, 200, checkout.body);
  const sessionId = `cs_fake_${invoiceId}`;
  missing.add(sessionId); // Stripe has never heard of it under this key
  // Age it past the sweep's grace window.
  await app.db.query(`UPDATE invoices SET updated_at = now() - interval '1 hour' WHERE id = $1`, [invoiceId]);

  const sweep = await runPaymentReconcileJob(app, { graceMinutes: 0 });
  assert.equal(sweep.errors, 0, 'a stale session is a known condition, not an error');
  assert.ok(sweep.retired >= 1, 'the sweep counts what it retired');
  assert.ok(asked.includes(sessionId), 'it did ask — the prefix could not decide this one');

  const row = await app.db.query<{ status: string; session: string | null }>(
    `SELECT status::text AS status, stripe_checkout_session_id AS session FROM invoices WHERE id = $1`, [invoiceId]);
  assert.equal(row.rows[0]!.status, 'sent');
  assert.equal(row.rows[0]!.session, null);

  // Second sweep: nothing left to ask about this invoice.
  asked.length = 0;
  await runPaymentReconcileJob(app, { graceMinutes: 0 });
  assert.ok(!asked.includes(sessionId), 'retired means retired — not asked again');
});

test('the return from Stripe names the invoice that was just paid', async () => {
  const client = await makeClient('Returnurl', 'return-url@example.test');
  const invoiceId = await sendInvoice(client.contactId, 20000);
  lastCheckout = null;
  const res = await app.inject({
    method: 'POST', url: `/portal/invoices/${invoiceId}/checkout`,
    headers: { authorization: `Bearer ${client.token}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const created = lastCheckoutSeen();
  assert.ok(created, 'a checkout was created');
  const url = new URL(created.successUrl);
  assert.equal(url.searchParams.get('paid'), '1');
  assert.equal(url.searchParams.get('invoice'), invoiceId, 'the portal is told WHICH invoice to confirm');
});

test('the live adapter reads its key mode from the key; the stub has none', async () => {
  const { makeStripeAdapter } = await import('../src/modules/billing/stripe.ts');
  const live = (key: string) =>
    makeStripeAdapter({ ...config, STRIPE_MODE: 'live', STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: 'whsec_synthetic' });
  assert.equal(live('sk_test_synthetic').keyMode, 'test');
  assert.equal(live('sk_live_synthetic').keyMode, 'live');
  assert.equal(live('rk_live_synthetic').keyMode, 'live');
  assert.equal(makeStripeAdapter({ ...config, STRIPE_MODE: 'stub' }).keyMode, null);
});
