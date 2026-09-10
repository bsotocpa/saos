// ITEM 9 (2026-09-09, Brian's ruling): the three client sends that fire from a system event
// — payment receipt (webhook), refund receipt (webhook), cancellation notice (void) — are
// gated automations, shipped OFF, each suppression recorded on the invoice's send log. The
// registry of deliberately ungated sends names a template and a recipient class per entry,
// and the staff channel (notifications) never reaches the client send primitives.
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { markInvoicePaid } from '../src/modules/billing/service.ts';
import { sendRefundReceipt } from '../src/modules/billing/refunds.ts';
import { sendVoidNotice } from '../src/modules/billing/void.ts';
import { UNGATED_CLIENT_SENDS } from '../src/modules/comms/client-sends.ts';
import { AUTOMATION_KEYS } from '../src/automations.ts';
import { notifyOnce } from '../src/staffing.ts';
import { enqueueEffect, drainOutbox } from '../src/outbox.ts';
import { noticesForInvoices } from '../src/modules/billing/notices.ts';

let app: FastifyInstance;
let config: Config;
const sent: MailMessage[] = [];
const capturingMailer: Mailer = { transport: 'console', async send(m) { sent.push(m); return { id: `cap-${sent.length}` }; } };

async function arm(key: string, enabled: boolean) {
  await app.db.query(`UPDATE automations SET enabled = $2 WHERE key = $1`, [key, enabled]);
}

let seq = 0;
async function invoiceFor(status: string) {
  seq += 1;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Gate${seq}`, email: `gate-${seq}@example.test` });
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at)
     VALUES ($1, $2, $3::invoice_status, 10000, 10000, 0, now()) RETURNING id`,
    [`SYN-GATE-${String(seq).padStart(4, '0')}`, c.id, status]
  );
  return { contactId: c.id, invoiceId: rows[0]!.id, email: `gate-${seq}@example.test` };
}

before(async () => {
  config = await createTestConfig('sendgates');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('the three system-fired sends are registered automations, and the registry no longer lists them as ungated', () => {
  for (const key of ['payment_receipt', 'refund_receipt', 'void_notice']) {
    assert.ok((AUTOMATION_KEYS as readonly string[]).includes(key), `${key} is a gated automation`);
  }
  const keys = Object.keys(UNGATED_CLIENT_SENDS);
  assert.ok(!keys.some((k) => /markInvoicePaid|sendRefundReceipt|sendVoidNotice/.test(k)), 'gated sends left the ungated registry');
  for (const [k, entry] of Object.entries(UNGATED_CLIENT_SENDS)) {
    assert.ok(entry.template.length > 0, `${k} names its template`);
    assert.ok(entry.recipientClass === 'client' || entry.recipientClass === 'staff', `${k} names its recipient class`);
    assert.ok(entry.reason.length > 40, `${k} has a written reason`);
  }
});

test('payment receipt OFF: the invoice is paid, no mail goes out, the hold is on the send log; ON: the receipt goes', async () => {
  await arm('payment_receipt', false);
  const a = await invoiceFor('sent');
  sent.length = 0;
  await markInvoicePaid(app, a.invoiceId, { paymentIntentId: `pi_gate_${seq}` });
  assert.equal((await app.db.query<{ s: string }>(`SELECT status::text AS s FROM invoices WHERE id = $1`, [a.invoiceId])).rows[0]!.s, 'paid', 'state bookkeeping is never gated');
  assert.deepEqual(sent.filter((m) => m.to === a.email), [], 'nothing reached the client');
  const held = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'invoice.payment_receipt_suppressed' AND object_id = $1`, [a.invoiceId]);
  assert.equal(held.rows.length, 1, 'the hold is recorded where the send would have been');

  await arm('payment_receipt', true);
  const b = await invoiceFor('sent');
  sent.length = 0;
  await markInvoicePaid(app, b.invoiceId, { paymentIntentId: `pi_gate_on_${seq}` });
  assert.equal(sent.filter((m) => m.to === b.email).length, 1, 'armed: the receipt goes out');
});

test('refund receipt and cancellation notice: OFF records the hold and sends nothing; ON sends', async () => {
  await arm('refund_receipt', false);
  const r = await invoiceFor('paid');
  await app.db.query(`UPDATE invoices SET amount_paid_cents = 10000, paid_at = now(), stripe_payment_intent_id = 'pi_gate_r' WHERE id = $1`, [r.invoiceId]);
  await app.db.query(`INSERT INTO invoice_refunds (invoice_id, stripe_refund_id, amount_cents) VALUES ($1, 're_gate_1', 4000)`, [r.invoiceId]);
  sent.length = 0;
  const off = await sendRefundReceipt(app, r.invoiceId, 're_gate_1');
  assert.deepEqual(off, { sent: false, reason: 'suppressed' });
  assert.deepEqual(sent.filter((m) => m.to === r.email), []);
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'invoice.refund_receipt_suppressed' AND object_id = $1`, [r.invoiceId])).rows.length, 1);
  await arm('refund_receipt', true);
  const on = await sendRefundReceipt(app, r.invoiceId, 're_gate_1');
  assert.equal(on.sent, true, 'armed: the refund receipt goes');

  await arm('void_notice', false);
  const v = await invoiceFor('void');
  sent.length = 0;
  const voff = await sendVoidNotice(app, v.invoiceId);
  assert.deepEqual(voff, { sent: false, reason: 'suppressed' });
  assert.deepEqual(sent.filter((m) => m.to === v.email), []);
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'invoice.void_notice_suppressed' AND object_id = $1`, [v.invoiceId])).rows.length, 1);
  await arm('void_notice', true);
  const von = await sendVoidNotice(app, v.invoiceId);
  assert.equal(von.sent, true, 'armed: the cancellation notice goes');
});

test('staff-only recipients: the staff channel writes a notification row and never touches the mailer', async () => {
  const staff = await makeStaff(app.db, config, { email: 'staff-gates@example.test', name: 'Synthetic Staff', role: 'comms_billing', password: 'comms_billing-password-1234567' });
  sent.length = 0;
  const wrote = await notifyOnce(app.db, { staffId: staff.id, type: 'synthetic_alert', severity: 'info', title: 'Synthetic staff alert' });
  assert.equal(wrote, true);
  assert.deepEqual(sent, [], 'a staff alert is a notification, not a client send');
  const row = await app.db.query(`SELECT 1 FROM notifications WHERE staff_id = $1 AND type = 'synthetic_alert'`, [staff.id]);
  assert.equal(row.rows.length, 1);
});

test('through the outbox: a held notice retires as SUPPRESSED — the row never claims it was sent', async () => {
  await arm('void_notice', false);
  const v = await invoiceFor('void');
  await enqueueEffect(app, { effect: 'invoice.void_notice', payload: { invoiceId: v.invoiceId }, contactId: v.contactId, objectType: 'invoice', objectId: v.invoiceId });
  sent.length = 0;
  const drain = await drainOutbox(app);
  const row = (await app.db.query<{ status: string; last_error: string | null; attempts: number; sent_at: Date | null }>(
    `SELECT status::text AS status, last_error, attempts, sent_at FROM outbox WHERE object_id = $1 AND effect = 'invoice.void_notice'`, [v.invoiceId])).rows[0]!;
  /*
   * 2026-09-10, Brian's ruling on the morning report. This row used to read 'sent'. Nothing was
   * sent — the gate held it — and anyone reading the table, or the raw send log which prints the
   * status verbatim, would have counted a send that never happened.
   */
  assert.equal(row.status, 'suppressed', 'retired as held, and it does not say sent');
  assert.equal(row.sent_at, null, 'nothing was sent, so there is no send time');
  assert.match(row.last_error ?? '', /^held/);
  assert.equal(drain.suppressed, 1, 'the drain counts a hold as a hold');
  assert.equal(drain.sent, 0);
  assert.deepEqual(sent.filter((m) => m.to === v.email), []);
  const notices = (await noticesForInvoices(app, [v.invoiceId]))[v.invoiceId]!;
  const held = notices.find((n) => n.kind === 'void_notice')!;
  assert.equal(held.state, 'skipped');
  assert.match(held.detail ?? '', /held/);
  await arm('void_notice', true);
});

/*
 * The other way a row retires without sending: the effect is no longer needed. That is not a
 * decision about the client and must not be counted as one — 'skipped', not 'suppressed', and
 * still never 'sent'.
 */
test('a notice someone already sent by hand retires as SKIPPED, which is not the same as held', async () => {
  await arm('void_notice', true);
  const v = await invoiceFor('void');
  const first = await sendVoidNotice(app, v.invoiceId);
  assert.equal(first.sent, true, 'the notice goes out once');

  await enqueueEffect(app, { effect: 'invoice.void_notice', payload: { invoiceId: v.invoiceId }, contactId: v.contactId, objectType: 'invoice', objectId: v.invoiceId });
  sent.length = 0;
  const drain = await drainOutbox(app);
  const row = (await app.db.query<{ status: string; last_error: string | null; sent_at: Date | null }>(
    `SELECT status::text AS status, last_error, sent_at FROM outbox WHERE object_id = $1 AND effect = 'invoice.void_notice' ORDER BY created_at DESC LIMIT 1`, [v.invoiceId])).rows[0]!;
  assert.equal(row.status, 'skipped', 'no longer needed is its own state');
  assert.equal(row.sent_at, null);
  assert.equal(drain.skipped, 1);
  assert.equal(drain.suppressed, 0, 'nobody held anything — this was not a decision');
  assert.deepEqual(sent.filter((m) => m.to === v.email), [], 'and it did not go a second time');
});

/* 'sent' means sent: the send log prints the status verbatim, so it has to be true on its own. */
test('a notice that actually goes out is the only one that reads sent', async () => {
  await arm('void_notice', true);
  const v = await invoiceFor('void');
  await enqueueEffect(app, { effect: 'invoice.void_notice', payload: { invoiceId: v.invoiceId }, contactId: v.contactId, objectType: 'invoice', objectId: v.invoiceId });
  sent.length = 0;
  const drain = await drainOutbox(app);
  const row = (await app.db.query<{ status: string; sent_at: Date | null }>(
    `SELECT status::text AS status, sent_at FROM outbox WHERE object_id = $1 AND effect = 'invoice.void_notice'`, [v.invoiceId])).rows[0]!;
  assert.equal(row.status, 'sent');
  assert.ok(row.sent_at, 'a real send has a send time');
  assert.equal(drain.sent, 1);
  assert.equal(sent.filter((m) => m.to === v.email).length, 1, 'the client really was written to');
});
