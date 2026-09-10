// DECISION 3 (2026-09-09, evening, corrected): arming an automation does not replay the sends
// it held; the held count is visible on the automation row. Three receipts held while
// payment_receipt was off, then armed from Admin: zero sends, and the row reads "3 held".
// Nothing here arms production — the test arms its own database. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { markInvoicePaid } from '../src/modules/billing/service.ts';
import { drainOutbox } from '../src/outbox.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
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

before(async () => {
  config = await createTestConfig('heldsends');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  ceo = await staffWithToken('ceo-held@example.test', 'ceo');
});

after(async () => {
  await app.close();
});

test('three receipts held while OFF; arming sends nothing and the row reads 3 held', async () => {
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'payment_receipt'`);
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Heldthree', email: 'heldthree@example.test' });
  const ids: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at)
       VALUES ($1, $2, 'sent', 10000, 10000, 0, now()) RETURNING id`, [`SYN-HELD-000${i}`, c.id]);
    ids.push(rows[0]!.id);
  }
  sent.length = 0;
  for (const id of ids) await markInvoicePaid(app, id, { paymentIntentId: `pi_held_${id.slice(0, 8)}` });
  assert.equal(sent.filter((m) => m.to === 'heldthree@example.test').length, 0, 'nothing reached the client while off');

  const before = await app.inject({ method: 'GET', url: '/admin/automations', headers: auth(ceo) });
  assert.equal(before.statusCode, 200, before.body);
  const rowBefore = (before.json().automations as Array<{ key: string; enabled: boolean; held_count: number }>).find((a) => a.key === 'payment_receipt')!;
  assert.equal(rowBefore.enabled, false);
  assert.equal(rowBefore.held_count, 3, 'the row counts what it held');

  // Arm it from Admin, the way Brian will.
  const armed = await app.inject({ method: 'PATCH', url: '/admin/automations/payment_receipt', headers: auth(ceo), payload: { enabled: true } });
  assert.equal(armed.statusCode, 200, armed.body);
  sent.length = 0;
  await drainOutbox(app);
  assert.equal(sent.length, 0, 'arming replays nothing');

  const after = await app.inject({ method: 'GET', url: '/admin/automations', headers: auth(ceo) });
  const rowAfter = (after.json().automations as Array<{ key: string; enabled: boolean; held_count: number }>).find((a) => a.key === 'payment_receipt')!;
  assert.equal(rowAfter.enabled, true);
  assert.equal(rowAfter.held_count, 3, 'the held count stays: they are still held, on their send logs');

  // A payment after arming sends, and does not touch the held count.
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at)
     VALUES ('SYN-HELD-0004', $1, 'sent', 10000, 10000, 0, now()) RETURNING id`, [c.id]);
  sent.length = 0;
  await markInvoicePaid(app, rows[0]!.id, { paymentIntentId: 'pi_held_after' });
  assert.equal(sent.filter((m) => m.to === 'heldthree@example.test').length, 1, 'armed: the new receipt goes');
  const again = await app.inject({ method: 'GET', url: '/admin/automations', headers: auth(ceo) });
  assert.equal((again.json().automations as Array<{ key: string; held_count: number }>).find((a) => a.key === 'payment_receipt')!.held_count, 3);
});
