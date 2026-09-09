// THE PAY LINK (2026-09-09, Brian's ruling).
//
// A signed, tokenized URL scoped to one invoice. No portal login: Stripe Checkout is the
// authentication. The token dies on paid, on void, or after 90 days, and a dead token gets
// a plain "no longer payable" answer with no invoice data in it. The portal invite stays a
// separate onboarding event.
//
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import type { StripeAdapter } from '../src/modules/billing/stripe.ts';
import { createTestConfig, makeContact, makeStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { sendInvoiceNow } from '../src/modules/billing/service.ts';
import { payLinkFor } from '../src/modules/billing/pay-link.ts';
import { voidInvoice } from '../src/modules/billing/void.ts';

let app: FastifyInstance;
let config: Config;
let staffId = '';

const sentMail: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    sentMail.push(msg);
    return { id: `captured-${sentMail.length}` };
  },
};

const paid = new Set<string>();
let lastCheckout: { successUrl: string; cancelUrl: string; customerEmail: string } | null = null;
function lastCheckoutSeen(): { successUrl: string; cancelUrl: string; customerEmail: string } | null { return lastCheckout; }
const fakeStripe: StripeAdapter = {
  mode: 'stub',
  keyMode: null,
  async createCheckoutSession(input) {
    lastCheckout = { successUrl: input.successUrl, cancelUrl: input.cancelUrl, customerEmail: input.customerEmail };
    const sessionId = `cs_fake_${input.invoiceId}`;
    return { sessionId, url: `https://checkout.stripe.example/${sessionId}` };
  },
  async retrieveCheckoutSession(sessionId) {
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

let seq = 0;
async function sentInvoice(cents = 20000): Promise<{ id: string; number: string; token: string; email: string }> {
  seq += 1;
  const email = `paylink-${seq}@example.test`;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Paylink${seq}`, email });
  const number = `SP-2026-${String(seq).padStart(4, '0')}`;
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, due_date)
     VALUES ($1, $2, 'draft', $3, $3, 0, CURRENT_DATE + 14) RETURNING id`,
    [number, c.id, cents]
  );
  sentMail.length = 0;
  const r = await sendInvoiceNow(app, rows[0]!.id, { type: 'system', label: 'test' });
  assert.equal(r.sent, true);
  const mail = sentMail.find((m) => m.to === email);
  assert.ok(mail, 'the invoice email went out');
  const body = String((mail as { text?: string; html?: string; body?: string }).text ?? (mail as { body?: string }).body ?? JSON.stringify(mail));
  const m = /\/pay\/([A-Za-z0-9_-]{20,})/.exec(body);
  assert.ok(m, `the invoice email carries a pay link, not a portal page: ${body.slice(0, 200)}`);
  return { id: rows[0]!.id, number, token: m![1]!, email };
}

const view = (token: string) => app.inject({ method: 'GET', url: `/public/pay/${token}` });

before(async () => {
  config = await createTestConfig('paylink');
  app = buildServer(config, { mailer: capturingMailer, stripe: fakeStripe });
  await app.ready();
  const s = await makeStaff(app.db, config, { email: 'ceo-paylink@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567' });
  staffId = s.id;
});

after(async () => {
  await app.close();
});

test('the invoice email carries a tokenized pay link; the page learns the number and the amount, nothing else', async () => {
  const inv = await sentInvoice(20000);
  const res = await view(inv.token);
  assert.equal(res.statusCode, 200, res.body);
  const v = res.json();
  assert.equal(v.state, 'payable');
  assert.equal(v.invoiceNumber, inv.number);
  assert.equal(v.amountCents, 20000);
  assert.deepEqual(Object.keys(v).sort(), ['amountCents', 'dueDate', 'invoiceNumber', 'language', 'state'], 'no contact data, no ids, no email on a public page');
  // The invite is a separate event: this email is not a sign-in link.
  const mail = sentMail.find((m) => m.to === inv.email)!;
  assert.ok(!JSON.stringify(mail).includes('/auth/verify'), 'the pay link is not a magic link');
});

test('a reminder carries the SAME link — the client never holds two', async () => {
  const inv = await sentInvoice();
  const again = await payLinkFor(app, inv.id);
  assert.ok(again.endsWith(`/pay/${inv.token}`), 'reused while live');
});

test('checkout needs no login: the token opens Stripe, and Stripe returns to the same token page', async () => {
  const inv = await sentInvoice(4500);
  lastCheckout = null;
  const res = await app.inject({ method: 'POST', url: `/public/pay/${inv.token}/checkout` });
  assert.equal(res.statusCode, 200, res.body);
  assert.match(res.json().url, /^https:\/\/checkout\.stripe\.example\//);
  const co = lastCheckoutSeen();
  assert.ok(co);
  assert.equal(co.successUrl, `${config.PORTAL_BASE_URL}/pay/${inv.token}?paid=1`);
  assert.equal(co.cancelUrl, `${config.PORTAL_BASE_URL}/pay/${inv.token}`);
  assert.equal(co.customerEmail, inv.email);
  const stored = await app.db.query<{ s: string }>(`SELECT stripe_checkout_session_id AS s FROM invoices WHERE id = $1`, [inv.id]);
  assert.equal(stored.rows[0]!.s, `cs_fake_${inv.id}`);
});

test('paid kills the token: the return page reads paid (number only), and a further checkout is refused', async () => {
  const inv = await sentInvoice(4500);
  await app.inject({ method: 'POST', url: `/public/pay/${inv.token}/checkout` });
  paid.add(`cs_fake_${inv.id}`);
  const rec = await app.inject({ method: 'POST', url: `/public/pay/${inv.token}/reconcile` });
  assert.equal(rec.statusCode, 200, rec.body);
  assert.equal(rec.json().status, 'paid');

  const res = await view(inv.token);
  assert.equal(res.json().state, 'paid');
  assert.equal(res.json().invoiceNumber, inv.number);
  assert.equal(res.json().amountCents, undefined, 'a paid page does not restate the amount');
  const row = await app.db.query<{ revoked: Date | null }>(`SELECT pay_token_revoked_at AS revoked FROM invoices WHERE id = $1`, [inv.id]);
  assert.ok(row.rows[0]!.revoked, 'the token is revoked on paid');

  const again = await app.inject({ method: 'POST', url: `/public/pay/${inv.token}/checkout` });
  assert.equal(again.statusCode, 409, again.body);
});

test('void kills the token: a plain "no longer payable" with no data at all', async () => {
  const inv = await sentInvoice();
  await voidInvoice(app, inv.id, { reason: 'Superseded by a replacement invoice' }, {
    id: staffId, email: 'ceo-paylink@example.test', fullName: 'Synthetic CEO', roleKey: 'ceo', permissions: ['*'], sessionId: 'test',
  });
  const res = await view(inv.token);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { state: 'unavailable' }, 'nothing about the invoice leaves the server');
  const rec = await app.inject({ method: 'POST', url: `/public/pay/${inv.token}/reconcile` });
  assert.equal(rec.statusCode, 404);
  const co = await app.inject({ method: 'POST', url: `/public/pay/${inv.token}/checkout` });
  assert.equal(co.statusCode, 409);
});

test('90 days kills the token, and a re-send after that gets a fresh one', async () => {
  const inv = await sentInvoice();
  await app.db.query(`UPDATE invoices SET pay_token_expires_at = now() - interval '1 day' WHERE id = $1`, [inv.id]);
  assert.deepEqual((await view(inv.token)).json(), { state: 'unavailable' });
  const fresh = await payLinkFor(app, inv.id);
  assert.ok(!fresh.endsWith(`/pay/${inv.token}`), 'a new token, not the dead one');
  const newToken = fresh.split('/pay/')[1]!;
  assert.equal((await view(newToken)).json().state, 'payable');
  assert.deepEqual((await view(inv.token)).json(), { state: 'unavailable' }, 'the old link stays dead');
});

test('a token nobody issued is simply unavailable', async () => {
  const res = await view('not_a_real_token_at_all_0000000000');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { state: 'unavailable' });
});
