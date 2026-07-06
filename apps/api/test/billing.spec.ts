// M13 "Prove it": filed → invoice automation (and the no-fee exception),
// portal Pay Now via the Stripe adapter, payment webhook (authenticated,
// idempotent), overdue automation, price-book invoice lines. The live
// Stripe test-mode run is parked on Brian's API keys — the adapter carries
// the signature-verification path for it. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { generateToken } from '../src/crypto.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };   // tax_preparer — drives the pipeline
let rene: TestStaff & { token: string };  // comms_billing — invoice queue

const sentMail: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    sentMail.push(msg);
    return { id: `captured-${sentMail.length}` };
  },
};

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email, password: staff.password, totp: code },
  });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

async function makeClient(last: string, email: string, language: 'en' | 'es' = 'en'): Promise<{ contactId: string; token: string }> {
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, language, soto_status)
     VALUES ('Synthetic', $1, $2, $3, 'active') RETURNING id`,
    [last, email, language]
  );
  const user = await app.db.query<{ id: string }>(
    `INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`,
    [contact.rows[0]!.id, email]
  );
  const { token, hash } = generateToken();
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`,
    [user.rows[0]!.id, hash]
  );
  return { contactId: contact.rows[0]!.id, token };
}

/** Engagement fabricated at ready_to_file with all gates satisfied. */
async function readyToFileEngagement(contactId: string): Promise<string> {
  const created = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { contactId, taxYear: 2025, returnType: '1040' },
  });
  const id = created.json().id as string;
  await app.db.query(
    `UPDATE tax_engagements
     SET stage = 'ready_to_file', engagement_letter_signed_at = now(),
         estimate_locked_at = now(), f8879_signed_at = now(), f8879_signature_method = 'in_person_wet',
         estimated_fee_min_cents = 30000, estimated_fee_max_cents = 40000
     WHERE id = $1`,
    [id]
  );
  return id;
}

before(async () => {
  config = await createTestConfig('bill');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  ana = await staffWithToken('ana-bill@example.test', 'tax_preparer');
  rene = await staffWithToken('rene-bill@example.test', 'comms_billing');
});

after(async () => {
  await app.close();
});

test('automation 12: filed with a final fee → invoice + ES portal notice + Rene queue + TE rollup', async () => {
  const luz = await makeClient('Billluz', 'bill-luz@example.test', 'es');
  const te = await readyToFileEngagement(luz.contactId);

  const fee = await app.inject({
    method: 'POST', url: `/tax-engagements/${te}/final-fee`, headers: auth(ana),
    payload: { finalFeeCents: 38000 },
  });
  assert.equal(fee.statusCode, 200, fee.body);

  const filed = await app.inject({
    method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(ana),
    payload: { toStage: 'filed' },
  });
  assert.equal(filed.statusCode, 200, filed.body);

  const invoice = await app.db.query(
    `SELECT id, invoice_number, status, total_cents, qb_exported_at FROM invoices WHERE tax_engagement_id = $1`,
    [te]
  );
  assert.equal(invoice.rows.length, 1, 'invoice auto-generated on filing');
  const inv = invoice.rows[0];
  assert.match(inv.invoice_number, /^SA-\d{4}-\d{4}$/);
  assert.equal(inv.status, 'sent');
  assert.equal(inv.total_cents, 38000);
  assert.equal(inv.qb_exported_at, null, 'QB export flag pending (automation 12)');

  const lines = await app.db.query(
    `SELECT description FROM invoice_line_items WHERE invoice_id = $1`,
    [inv.id]
  );
  assert.match(lines.rows[0].description, /Preparación/, 'line rendered in the client language');

  const teRow = await app.db.query(
    `SELECT invoice_number, invoice_amount_cents, payment_status FROM tax_engagements WHERE id = $1`,
    [te]
  );
  assert.equal(teRow.rows[0].invoice_number, inv.invoice_number);
  assert.equal(teRow.rows[0].payment_status, 'invoiced');

  const mail = sentMail.find((m) => m.to === 'bill-luz@example.test');
  assert.ok(mail, 'portal notice sent');
  assert.match(mail.subject, /Factura/);
  assert.match(mail.text, /\$380\.00/);

  const queue = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'invoice_generated' AND staff_id = $1`,
    [rene.id]
  );
  assert.equal(queue.rows[0].n, 1, 'Rene sees the new invoice');
});

test('automation 12 exception: filed WITHOUT a final fee → no invoice, Rene alerted instead', async () => {
  const mo = await makeClient('Billmo', 'bill-mo@example.test');
  const te = await readyToFileEngagement(mo.contactId);
  const filed = await app.inject({
    method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(ana),
    payload: { toStage: 'filed' },
  });
  assert.equal(filed.statusCode, 200, filed.body);

  const invoices = await app.db.query(`SELECT count(*)::int AS n FROM invoices WHERE tax_engagement_id = $1`, [te]);
  assert.equal(invoices.rows[0].n, 0);
  const alert = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'invoice_needed' AND staff_id = $1 AND contact_id = $2`,
    [rene.id, mo.contactId]
  );
  assert.equal(alert.rows[0].n, 1, 'exception routed to Rene — nothing silently skipped');
});

test('portal Pay Now: own invoices listed, checkout session created, foreign invoices 404', async () => {
  const pia = await makeClient('Billpia', 'bill-pia@example.test');
  const otto = await makeClient('Billotto', 'bill-otto@example.test');
  const te = await readyToFileEngagement(pia.contactId);
  await app.inject({
    method: 'POST', url: `/tax-engagements/${te}/final-fee`, headers: auth(ana),
    payload: { finalFeeCents: 25000 },
  });
  await app.inject({
    method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(ana),
    payload: { toStage: 'filed' },
  });

  const list = await app.inject({ method: 'GET', url: '/portal/invoices', headers: auth(pia) });
  assert.equal(list.json().invoices.length, 1);
  const invoiceId = list.json().invoices[0].id as string;
  assert.equal(list.json().invoices[0].lines.length, 1);

  const ottoList = await app.inject({ method: 'GET', url: '/portal/invoices', headers: auth(otto) });
  assert.equal(ottoList.json().invoices.length, 0, 'row-level isolation');

  const checkout = await app.inject({
    method: 'POST', url: `/portal/invoices/${invoiceId}/checkout`, headers: auth(pia),
  });
  assert.equal(checkout.statusCode, 200, checkout.body);
  assert.match(checkout.json().url, /^https:\/\/checkout\.stripe\.example\//);
  const stored = await app.db.query(`SELECT stripe_checkout_session_id FROM invoices WHERE id = $1`, [invoiceId]);
  assert.equal(stored.rows[0].stripe_checkout_session_id, `cs_stub_${invoiceId}`);

  const foreign = await app.inject({
    method: 'POST', url: `/portal/invoices/${invoiceId}/checkout`, headers: auth(otto),
  });
  assert.equal(foreign.statusCode, 404, 'cannot pay someone else’s invoice');
});

test('payment webhook: authenticated, marks paid + receipt + TE rollup, idempotent on replay', async () => {
  const raj = await makeClient('Billraj', 'bill-raj@example.test');
  const te = await readyToFileEngagement(raj.contactId);
  // 42000 would exceed the 40000 estimate top → scope creep needs a reason.
  const fee = await app.inject({
    method: 'POST', url: `/tax-engagements/${te}/final-fee`, headers: auth(ana),
    payload: { finalFeeCents: 42000, scopeCreepReason: 'late_docs' },
  });
  assert.equal(fee.statusCode, 200, fee.body);
  await app.inject({
    method: 'POST', url: `/tax-engagements/${te}/transition`, headers: auth(ana),
    payload: { toStage: 'filed' },
  });
  const inv = await app.db.query<{ id: string }>(`SELECT id FROM invoices WHERE tax_engagement_id = $1`, [te]);
  const invoiceId = inv.rows[0]!.id;

  const payload = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: `cs_stub_${invoiceId}`, payment_intent: 'pi_stub_1', metadata: { invoice_id: invoiceId } } },
  });

  // Wrong secret → refused (the stub's auth; the live adapter verifies the Stripe signature).
  const bad = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'x-webhook-secret': 'wrong', 'content-type': 'application/json' },
    payload,
  });
  assert.equal(bad.statusCode, 401);

  const ok = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET, 'content-type': 'application/json' },
    payload,
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().alreadyPaid, false);

  const paid = await app.db.query(
    `SELECT status, amount_paid_cents, paid_at, stripe_payment_intent_id FROM invoices WHERE id = $1`,
    [invoiceId]
  );
  assert.equal(paid.rows[0].status, 'paid');
  assert.equal(paid.rows[0].amount_paid_cents, 42000);
  assert.ok(paid.rows[0].paid_at);
  assert.equal(paid.rows[0].stripe_payment_intent_id, 'pi_stub_1');

  const teRow = await app.db.query(`SELECT payment_status, payment_received_at FROM tax_engagements WHERE id = $1`, [te]);
  assert.equal(teRow.rows[0].payment_status, 'paid');
  assert.ok(teRow.rows[0].payment_received_at);

  const receipt = sentMail.find((m) => m.to === 'bill-raj@example.test' && /Payment received/i.test(m.subject));
  assert.ok(receipt, 'receipt sent');
  assert.match(receipt.text, /\$420\.00/);

  // Replay: acknowledged, nothing double-processed.
  const replay = await app.inject({
    method: 'POST', url: '/webhooks/stripe',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET, 'content-type': 'application/json' },
    payload,
  });
  assert.equal(replay.json().alreadyPaid, true);
});

test('automation 17: unpaid past the window → overdue + reminder + Rene flag, once', async () => {
  const zoe = await makeClient('Billzoe', 'bill-zoe@example.test');
  const created = await app.inject({
    method: 'POST', url: '/invoices', headers: auth(rene),
    payload: { contactId: zoe.contactId, lines: [{ code: 'ENTITY_BOI' }] },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().totalCents, 12000, 'line priced from the book (BOI $120)');
  const invoiceId = created.json().id as string;
  await app.db.query(`UPDATE invoices SET sent_at = now() - interval '15 days' WHERE id = $1`, [invoiceId]);

  const run = await app.inject({ method: 'POST', url: '/jobs/invoice-overdue?asOf=2026-07-20', headers: auth(ana) });
  assert.equal(run.statusCode, 403, 'preparer cannot trigger jobs'); // jobs.run is leadership-only

  const brian = await staffWithToken('brian-bill@example.test', 'ceo');
  const run2 = await app.inject({ method: 'POST', url: '/jobs/invoice-overdue?asOf=2026-07-20', headers: auth(brian) });
  assert.equal(run2.statusCode, 200, run2.body);
  assert.equal(run2.json().overdue, 1);

  const inv = await app.db.query(`SELECT status FROM invoices WHERE id = $1`, [invoiceId]);
  assert.equal(inv.rows[0].status, 'overdue');
  const reminder = sentMail.find((m) => m.to === 'bill-zoe@example.test' && /reminder/i.test(m.subject));
  assert.ok(reminder, 'client reminder sent');
  const flag = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'invoice_overdue' AND staff_id = $1`,
    [rene.id]
  );
  assert.equal(flag.rows[0].n, 1, 'Rene flagged');

  // Same-date re-run: date guard skips; Rene's flag never duplicates.
  const run3 = await app.inject({ method: 'POST', url: '/jobs/invoice-overdue?asOf=2026-07-20', headers: auth(brian) });
  assert.equal(run3.json().skipped, true);
  const stillOne = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'invoice_overdue' AND staff_id = $1`,
    [rene.id]
  );
  assert.equal(stillOne.rows[0].n, 1);
});

test('invoice guardrails: pass-throughs not invoiceable; range items need explicit amounts', async () => {
  const kay = await makeClient('Billkay', 'bill-kay@example.test');
  const passThrough = await app.inject({
    method: 'POST', url: '/invoices', headers: auth(rene),
    payload: { contactId: kay.contactId, lines: [{ code: 'PASS_QBO' }] },
  });
  assert.equal(passThrough.statusCode, 400);
  assert.equal(passThrough.json().error, 'pass_through_not_invoiceable');

  const rangeItem = await app.inject({
    method: 'POST', url: '/invoices', headers: auth(rene),
    payload: { contactId: kay.contactId, lines: [{ code: 'IND_CPA_LETTER' }] },
  });
  assert.equal(rangeItem.statusCode, 400);
  assert.equal(rangeItem.json().error, 'requires_custom_amount');
});
