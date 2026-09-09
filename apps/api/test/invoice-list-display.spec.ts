// THE OPS INVOICE LIST SAYS WHAT HAPPENED (2026-09-09, Brian's ruling): one client with a
// paid, a void, a refunded and a partially refunded invoice; the list carries, for each, the
// same status column the portal reads plus what the card must print inline — void reason,
// actor and date; refunded amount and date. The card's text itself is proved in
// apps/internal/test/invoice-display.spec.ts against this shape. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff & { token: string };
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
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
  config = await createTestConfig('invlist');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  rene = await staffWithToken('rene-invlist@example.test', 'comms_billing');
});

after(async () => {
  await app.close();
});

test('paid, void, refunded and partially refunded all come back with what the card must print', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Fourstates', email: 'fourstates@example.test' });
  const ins = async (n: string, status: string, total: number, paid: number, extra = '') => {
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at, paid_at ${extra ? ', ' + extra.split('=')[0] : ''})
       VALUES ($1, $2, $3::invoice_status, $4, $4, $5, now() - interval '3 days', CASE WHEN $5 > 0 THEN now() - interval '2 days' ELSE NULL END ${extra ? ', ' + extra.split('=')[1] : ''})
       RETURNING id`,
      [n, c.id, status, total, paid]
    );
    return rows[0]!.id;
  };
  const paidId = await ins('SL-2026-0001', 'paid', 2000, 2000);
  // Void: through the real path so reason, actor and date are what the route records.
  const voidId = await ins('SL-2026-0002', 'sent', 20000, 0);
  const v = await app.inject({ method: 'POST', url: `/invoices/${voidId}/void`, headers: auth(rene), payload: { reason: 'testing testing testing' } });
  assert.equal(v.statusCode, 200, v.body);
  // Refunded and partially refunded: rows as the webhook leaves them — the refund ROW first,
  // then the status. The state machine (0084) refuses the other order: refunds are recorded, never asserted.
  const refundedId = await ins('SL-2026-0003', 'paid', 2000, 2000);
  await app.db.query(`INSERT INTO invoice_refunds (invoice_id, stripe_refund_id, amount_cents, reason) VALUES ($1, 're_test_list_full', 2000, 'requested_by_customer')`, [refundedId]);
  await app.db.query(`UPDATE invoices SET status = 'refunded', amount_refunded_cents = 2000 WHERE id = $1`, [refundedId]);
  const partialId = await ins('SL-2026-0004', 'paid', 2000, 2000);
  await app.db.query(`INSERT INTO invoice_refunds (invoice_id, stripe_refund_id, amount_cents, reason) VALUES ($1, 're_test_list_part', 500, NULL)`, [partialId]);
  await app.db.query(`UPDATE invoices SET status = 'partially_refunded', amount_refunded_cents = 500 WHERE id = $1`, [partialId]);

  const res = await app.inject({ method: 'GET', url: `/invoices?contactId=${c.id}`, headers: auth(rene) });
  assert.equal(res.statusCode, 200, res.body);
  const byId = new Map((res.json().invoices as Array<Record<string, unknown>>).map((i) => [i.id as string, i]));

  const paid = byId.get(paidId)!;
  assert.equal(paid.status, 'paid');

  const voided = byId.get(voidId)!;
  assert.equal(voided.status, 'void', 'the same status column the portal reads');
  assert.equal(voided.void_reason, 'testing testing testing');
  assert.equal(voided.voided_by, 'rene-invlist@example.test', 'the actor, by email');
  assert.ok(voided.voided_at, 'the date');

  const refunded = byId.get(refundedId)!;
  assert.equal(refunded.status, 'refunded');
  assert.equal(refunded.amount_refunded_cents, 2000);
  assert.ok(refunded.refunded_at, 'the refund date comes from the refund row');

  const partial = byId.get(partialId)!;
  assert.equal(partial.status, 'partially_refunded');
  assert.equal(partial.amount_refunded_cents, 500);
  assert.equal(partial.amount_paid_cents, 2000, 'so the card can say $5.00 of $20.00');
  assert.ok(partial.refunded_at);
});
