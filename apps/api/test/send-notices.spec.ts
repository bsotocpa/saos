// THE FLASH TELLS THE TRUTH (2026-09-09, Brian's ruling).
//
// "The client has been told" was said over an outbox row that delivered forty-one seconds
// later. Every post-action notice that involves a send now states the ACTUAL state from the
// record: queued (an outbox row, not delivered) or delivered (the send log confirms it, with
// the time). The tests below block the outbox worker simply by not running it, and expect
// the word "queued"; then run it, and expect "delivered".
//
// Also here: the outbox claim is a lease, because two overlapping drains once performed the
// same refund receipt twice. Synthetic data only.

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
import { markInvoicePaid } from '../src/modules/billing/service.ts';
import { describeNotice, type NoticeState } from '../src/modules/billing/notices.ts';
import { mapStripeEvent } from '../src/modules/billing/stripe.ts';
import { readFileSync } from 'node:fs';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff & { token: string };

const sentMail: MailMessage[] = [];
/** A gate the test can hold shut, to make a send take as long as it likes. */
let holdSends: Promise<void> | null = null;
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    if (holdSends) await holdSends;
    sentMail.push(msg);
    return { id: `captured-${sentMail.length}` };
  },
};

const fakeStripe: StripeAdapter = {
  mode: 'stub',
  keyMode: null,
  async retrieveCharge() { return null; },
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
};

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

let seq = 0;
async function invoice(status: 'sent' | 'paid', cents = 20000, pi: string | null = null) {
  seq += 1;
  const email = `notice-${seq}@example.test`;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Notice${seq}`, email });
  const number = `SN-2026-${String(seq).padStart(4, '0')}`;
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at, paid_at, stripe_payment_intent_id)
     VALUES ($1, $2, $3::invoice_status, $4, $4, $5, now() - interval '1 day', CASE WHEN $3 = 'paid' THEN now() ELSE NULL END, $6) RETURNING id`,
    [number, c.id, status, cents, status === 'paid' ? cents : 0, pi]
  );
  return { id: rows[0]!.id, number, contactId: c.id, email };
}

async function noticesOf(contactId: string, invoiceId: string) {
  const res = await app.inject({ method: 'GET', url: `/invoices?contactId=${contactId}`, headers: auth(rene) });
  assert.equal(res.statusCode, 200, res.body);
  const inv = (res.json().invoices as Array<{ id: string; notices: NoticeState[] }>).find((i) => i.id === invoiceId);
  assert.ok(inv, 'the invoice is in the list');
  return inv!.notices;
}

before(async () => {
  config = await createTestConfig('notices');
  app = buildServer(config, { mailer: capturingMailer, stripe: fakeStripe });
  await app.ready();
  rene = await staffWithToken('rene-notices@example.test', 'comms_billing');
});

after(async () => {
  await app.close();
});

test('void says "queued" while the worker has not run, then "delivered" with the time once it has', async () => {
  const inv = await invoice('sent');
  const res = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(rene), payload: { reason: 'Superseded by the corrected invoice.' } });
  assert.equal(res.statusCode, 200, res.body);
  const notice = res.json().notice;
  assert.equal(notice.kind, 'void_notice');
  assert.equal(notice.state, 'queued', 'the worker has not run: the truth is "queued"');
  assert.ok(notice.outboxId, 'and it points at the outbox row');
  assert.equal(notice.at, null);
  assert.match(describeNotice(notice), /^Cancellation notice queued/);

  // The list agrees, from the same record.
  let listed = await noticesOf(inv.contactId, inv.id);
  assert.equal(listed.find((n) => n.kind === 'void_notice')?.state, 'queued');

  // The worker runs: now, and only now, it is delivered — with a time and the audit row.
  await drainOutbox(app);
  listed = await noticesOf(inv.contactId, inv.id);
  const delivered = listed.find((n) => n.kind === 'void_notice')!;
  assert.equal(delivered.state, 'delivered');
  assert.ok(delivered.at, 'delivered carries the time');
  assert.ok(delivered.auditId, 'and links to the send-log row');
  assert.match(describeNotice(delivered), /^Cancellation notice delivered /);

  const log = await app.inject({ method: 'GET', url: `/invoices/${inv.id}/sends`, headers: auth(rene) });
  assert.equal(log.statusCode, 200);
  const rows = log.json().rows as Array<{ source: string; what: string; state: string }>;
  assert.ok(rows.some((r) => r.source === 'outbox' && r.what.startsWith('invoice.void_notice')), 'the outbox row is in the send log');
  assert.ok(rows.some((r) => r.source === 'audit' && r.what === 'invoice.void_notice_sent'), 'and so is the audit row that says it left');
});

test('the refund receipt follows the same rule: queued by the webhook, delivered by the worker', async () => {
  const inv = await invoice('paid', 2000, 'pi_test_notice_refund');
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/stripe/charge.refunded.json', import.meta.url), 'utf8'));
  fixture.id = 'evt_test_notice_refund';
  fixture.data.object.payment_intent = 'pi_test_notice_refund';
  fixture.data.object.refunds.data[0].id = 're_test_notice_refund';
  const hook = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET, 'content-type': 'application/json' },
    payload: JSON.stringify(fixture),
  });
  assert.equal(hook.statusCode, 200, hook.body);
  let listed = await noticesOf(inv.contactId, inv.id);
  assert.equal(listed.find((n) => n.kind === 'refund_receipt')?.state, 'queued');
  await drainOutbox(app);
  listed = await noticesOf(inv.contactId, inv.id);
  const r = listed.find((n) => n.kind === 'refund_receipt')!;
  assert.equal(r.state, 'delivered');
  assert.ok(r.at && r.auditId);
});

test('the payment receipt is sent inline, so it reads delivered at once — and only because its audit row exists', async () => {
  const inv = await invoice('sent', 5000);
  await markInvoicePaid(app, inv.id, { paymentIntentId: 'pi_test_notice_paid' });
  const listed = await noticesOf(inv.contactId, inv.id);
  const p = listed.find((n) => n.kind === 'payment_receipt')!;
  assert.ok(p, 'the receipt is on the record');
  assert.equal(p.state, 'delivered');
  assert.ok(p.auditId, 'linked to the audit row that says it left');
});

test('two overlapping drains perform an effect ONCE — the claim is a lease', async () => {
  const inv = await invoice('sent');
  await app.inject({ method: 'POST', url: `/invoices/${inv.id}/void`, headers: auth(rene), payload: { reason: 'Superseded by the corrected invoice.' } });
  sentMail.length = 0;
  let release!: () => void;
  holdSends = new Promise<void>((resolve) => { release = resolve; });
  // Both drains start while the first send is held open — the exact overlap of 09:08:55.
  const first = drainOutbox(app);
  await new Promise((r) => setTimeout(r, 50));
  const second = drainOutbox(app);
  await new Promise((r) => setTimeout(r, 50));
  release();
  holdSends = null;
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.sent + b.sent, 1, 'exactly one drain performed it');
  assert.equal(sentMail.filter((m) => m.to === inv.email).length, 1, 'the client got exactly one cancellation notice');
  const row = await app.db.query<{ attempts: number; status: string }>(
    `SELECT attempts, status::text AS status FROM outbox WHERE object_id = $1 AND effect = 'invoice.void_notice'`, [inv.id]);
  assert.equal(row.rows[0]!.attempts, 1, 'claimed once');
  assert.equal(row.rows[0]!.status, 'sent');
});
