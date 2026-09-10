// ITEM 14 (2026-09-09, Brian's phone-walk ruling): ONE link per invoice. The Ops card no longer
// prints a portal URL; a person presses "Send the pay link" and the tokenized link goes by
// email or by text, audited as invoice.pay_link_sent, on the invoice's send log.
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { noticesForInvoices } from '../src/modules/billing/notices.ts';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff & { token: string };
const sent: MailMessage[] = [];
const capturingMailer: Mailer = { transport: 'console', async send(m) { sent.push(m); return { id: `cap-${sent.length}` }; } };
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
async function invoice(status: string, opts: { phone?: string; smsConsent?: boolean } = {}) {
  seq += 1;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Paylink${seq}`, email: `paylink-${seq}@example.test` });
  await app.db.query(`UPDATE contacts SET phone = $2, sms_consent = $3 WHERE id = $1`, [c.id, opts.phone ?? null, opts.smsConsent ?? false]);
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at)
     VALUES ($1, $2, $3::invoice_status, 10000, 10000, 0, now()) RETURNING id`, [`SYN-PL-${String(seq).padStart(4, '0')}`, c.id, status]);
  return { contactId: c.id, email: `paylink-${seq}@example.test`, invoiceId: rows[0]!.id };
}

before(async () => {
  config = await createTestConfig('paylinksend');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  rene = await staffWithToken('rene-paylink@example.test', 'comms_billing');
});

after(async () => {
  await app.close();
});

test('email: the tokenized pay link goes out, is audited, and reads "Pay link delivered" on the send log', async () => {
  const x = await invoice('sent');
  sent.length = 0;
  const res = await app.inject({ method: 'POST', url: `/invoices/${x.invoiceId}/pay-link/send`, headers: auth(rene), payload: { channel: 'email' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().channel, 'email');
  const mail = sent.find((m) => m.to === x.email);
  assert.ok(mail, 'one email to the client');
  assert.match(mail!.text ?? mail!.html ?? '', /\/pay\/[A-Za-z0-9_-]{20,}/, 'the TOKEN link, not the portal invoices URL');
  assert.doesNotMatch(mail!.text ?? mail!.html ?? '', /invoices\?invoice=/, 'never the portal URL');
  const audit = await app.db.query<{ details: { channel: string } }>(`SELECT details FROM audit_log WHERE action = 'invoice.pay_link_sent' AND object_id = $1`, [x.invoiceId]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.details.channel, 'email');
  const notices = (await noticesForInvoices(app, [x.invoiceId]))[x.invoiceId]!;
  assert.ok(notices.some((n) => n.kind === 'pay_link' && n.state === 'delivered'), 'on the send log');
});

test('text: no consent is refused by the TCPA gate; consent without Twilio says so; nothing is audited as sent', async () => {
  const noConsent = await invoice('sent', { phone: '3125550100', smsConsent: false });
  const r1 = await app.inject({ method: 'POST', url: `/invoices/${noConsent.invoiceId}/pay-link/send`, headers: auth(rene), payload: { channel: 'sms' } });
  assert.equal(r1.statusCode, 409, r1.body);
  assert.equal(r1.json().error, 'sms_no_sms_consent');

  const consented = await invoice('sent', { phone: '3125550101', smsConsent: true });
  const r2 = await app.inject({ method: 'POST', url: `/invoices/${consented.invoiceId}/pay-link/send`, headers: auth(rene), payload: { channel: 'sms' } });
  assert.equal(r2.statusCode, 409, r2.body);
  assert.equal(r2.json().error, 'sms_twilio_not_configured', 'the reason is the real one');
  const audits = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'invoice.pay_link_sent' AND object_id = ANY($1::text[])`, [[noConsent.invoiceId, consented.invoiceId]]);
  assert.equal(audits.rows.length, 0, 'a refused text is never recorded as sent');
});

test('only an open invoice has a pay link to send: paid and void are refused', async () => {
  for (const status of ['paid', 'void', 'draft']) {
    const x = await invoice(status);
    const res = await app.inject({ method: 'POST', url: `/invoices/${x.invoiceId}/pay-link/send`, headers: auth(rene), payload: { channel: 'email' } });
    assert.equal(res.statusCode, 409, `${status}: ${res.body}`);
    assert.equal(res.json().error, 'not_payable');
  }
});
