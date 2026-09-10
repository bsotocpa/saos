// AUDIT ITEM 3 (2026-09-09, Brian's ruling): the reminder control appears only for a sent or
// overdue invoice and says the amount it will chase; the route refuses every other status in
// words. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

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
async function invoice(status: string) {
  seq += 1;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Remind${seq}`, email: `remind-${seq}@example.test` });
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at)
     VALUES ($1, $2, $3::invoice_status, 12500, 12500, 0, now()) RETURNING id`, [`SYN-REM-${String(seq).padStart(4, '0')}`, c.id, status]);
  return { email: `remind-${seq}@example.test`, invoiceId: rows[0]!.id };
}

before(async () => {
  config = await createTestConfig('remindscope');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  rene = await staffWithToken('rene-remind@example.test', 'comms_billing');
});

after(async () => {
  await app.close();
});

test('draft, void and partially refunded invoices are not chased; sent and overdue are', async () => {
  for (const status of ['draft', 'void', 'partially_refunded']) {
    const x = await invoice(status === 'partially_refunded' ? 'paid' : status);
    if (status === 'partially_refunded') {
      await app.db.query(`UPDATE invoices SET amount_paid_cents = 12500 WHERE id = $1`, [x.invoiceId]);
      await app.db.query(`INSERT INTO invoice_refunds (invoice_id, stripe_refund_id, amount_cents) VALUES ($1, 're_remind', 2500)`, [x.invoiceId]);
      await app.db.query(`UPDATE invoices SET status = 'partially_refunded', amount_refunded_cents = 2500 WHERE id = $1`, [x.invoiceId]);
    }
    const res = await app.inject({ method: 'POST', url: `/invoices/${x.invoiceId}/remind`, headers: auth(rene) });
    assert.equal(res.statusCode, 409, `${status}: ${res.body}`);
    assert.ok(['not_payable', 'already_paid'].includes(res.json().error), res.body);
  }
  for (const status of ['sent', 'overdue']) {
    const x = await invoice(status);
    sent.length = 0;
    const res = await app.inject({ method: 'POST', url: `/invoices/${x.invoiceId}/remind`, headers: auth(rene) });
    assert.equal(res.statusCode, 200, `${status}: ${res.body}`);
    assert.equal(sent.filter((m) => m.to === x.email).length, 1, `${status}: one reminder`);
    assert.match(sent[0]!.text, /\$125\.00/, 'the reminder names the amount it chases');
  }
});
