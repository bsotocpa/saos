/*
 * THE STRIPE DRIFT WAIVER (2026-09-12, ruling reconciliation; the finding was 2026-09-11 item 6).
 * A payment the current key cannot see raised a task nobody could resolve, daily. A person with
 * billing.manage waives the check with a reason: the open drift tasks close, the decision is
 * audited, the nightly check skips the invoice and counts it, and the money fields are untouched.
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createInvoice, markInvoicePaid } from '../src/modules/billing/service.ts';
import { runStripeDriftCheckJob } from '../src/modules/billing/drift.ts';
import { createTask } from '../src/modules/tasks/service.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

before(async () => {
  config = await createTestConfig('driftwaiver');
  app = buildServer(config);
  await app.ready();
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email: 'brian-waiver@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-12345678', totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: staff.email, password: staff.password, totp: code } });
  brian = { ...staff, token: res.json().token as string };
});
after(async () => { await app.close(); });

test('waiving: reason required, tasks close, audited, the check skips and counts it, the money is untouched', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Waiver', email: 'waiver@example.test' });
  const actor = { type: 'staff' as const, id: brian.id, label: brian.fullName };
  const item = await app.db.query<{ amount_cents: number }>(
    `SELECT pbi.amount_cents FROM price_book_items pbi JOIN price_book_versions v ON v.id = pbi.version_id
      WHERE pbi.is_active AND pbi.amount_cents > 0 ORDER BY pbi.amount_cents LIMIT 1`);
  const inv = await createInvoice(app, actor, { contactId: c.id, lines: [{ description: 'Synthetic paid under another key', unitCents: item.rows[0]!.amount_cents }], send: false, issued: true });
  await markInvoicePaid(app, inv.id, { paymentIntentId: 'pi_synthetic_other_key' });
  const task = await createTask(app, { title: 'Stripe cannot verify this payment', contactId: c.id, priority: 2, source: 'automation', sourceType: 'stripe_drift', sourceId: inv.id });
  assert.ok(task.created);

  const listed = await app.inject({ method: 'GET', url: `/invoices?contactId=${c.id}`, headers: auth(brian) });
  assert.equal((listed.json() as { invoices: { has_open_drift_finding: boolean }[] }).invoices[0]!.has_open_drift_finding, true, 'the card knows there is a finding to waive');
  const noReason = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/waive-stripe-check`, headers: auth(brian), payload: { reason: 'ok' } });
  assert.equal(noReason.statusCode, 400, 'a reason is a sentence for the next reader');
  const chat = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/waive-stripe-check`, headers: auth(brian), payload: { reason: 'as discussed in our chat, ruling 6' } });
  assert.equal(chat.statusCode, 400, 'a reason may not cite a conversation');

  const before = await app.db.query<{ status: string; amount_paid_cents: number }>(`SELECT status::text AS status, amount_paid_cents FROM invoices WHERE id = $1`, [inv.id]);
  const waived = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/waive-stripe-check`, headers: auth(brian), payload: { reason: 'Paid under the Stripe test key on 2026-08-13; the live key cannot see that payment intent.' } });
  assert.equal(waived.statusCode, 200, waived.body);
  const after = await app.db.query<{ status: string; amount_paid_cents: number; waived_at: Date | null; reason: string | null }>(
    `SELECT status::text AS status, amount_paid_cents, stripe_check_waived_at AS waived_at, stripe_check_waived_reason AS reason FROM invoices WHERE id = $1`, [inv.id]);
  assert.deepEqual({ status: after.rows[0]!.status, paid: after.rows[0]!.amount_paid_cents }, { status: before.rows[0]!.status, paid: before.rows[0]!.amount_paid_cents }, 'the money fields did not move');
  assert.ok(after.rows[0]!.waived_at);
  assert.match(after.rows[0]!.reason ?? '', /test key/);
  const closed = await app.db.query<{ status: string }>(`SELECT status::text AS status FROM tasks WHERE id = $1`, [task.id]);
  assert.notEqual(closed.rows[0]!.status, 'not_started', 'the open drift task is closed');
  assert.equal((await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'invoice.stripe_check_waived' AND object_id = $1`, [inv.id])).rows.length, 1);
  const twice = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/waive-stripe-check`, headers: auth(brian), payload: { reason: 'Waiving it a second time, for the test.' } });
  assert.equal(twice.statusCode, 409);

  // The nightly check: the waived invoice is not checked, is counted, and raises no task.
  const run = await runStripeDriftCheckJob(app, '2031-01-01');
  assert.equal(run.checked, 0, 'the waived invoice is skipped');
  const audit = await app.db.query<{ details: { waived: string[] } }>(`SELECT details FROM audit_log WHERE action = 'ops.stripe_drift_checked' AND details->>'day' = '2031-01-01'`);
  assert.deepEqual(audit.rows[0]!.details.waived, [inv.invoiceNumber], 'and named on the run record');
  const reopened = await app.db.query(`SELECT 1 FROM tasks WHERE source_type = 'stripe_drift' AND source_id = $1 AND status = 'not_started'`, [inv.id]);
  assert.equal(reopened.rows.length, 0, 'no new drift task');

  const list = await app.inject({ method: 'GET', url: `/invoices?contactId=${c.id}`, headers: auth(brian) });
  const row = (list.json() as { invoices: { stripe_check_waived_reason: string | null; has_stripe_payment: boolean; has_open_drift_finding: boolean }[] }).invoices[0]!;
  assert.match(row.stripe_check_waived_reason ?? '', /test key/, 'the card can say so');
  assert.equal(row.has_stripe_payment, true);
  assert.equal(row.has_open_drift_finding, false, 'and the finding is closed, so the control goes');
});

test('a paid invoice that verifies fine (no open finding) cannot be waived, so the control is not offered', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Verifies', email: 'verifies@example.test' });
  const item = await app.db.query<{ amount_cents: number }>(`SELECT pbi.amount_cents FROM price_book_items pbi WHERE pbi.is_active AND pbi.amount_cents > 0 ORDER BY pbi.amount_cents LIMIT 1`);
  const inv = await createInvoice(app, { type: 'staff', id: brian.id, label: brian.fullName }, { contactId: c.id, lines: [{ description: 'Synthetic paid, verifies', unitCents: item.rows[0]!.amount_cents }], send: false, issued: true });
  await markInvoicePaid(app, inv.id, { paymentIntentId: 'pi_synthetic_verifies' });
  const listed = await app.inject({ method: 'GET', url: `/invoices?contactId=${c.id}`, headers: auth(brian) });
  assert.equal((listed.json() as { invoices: { has_open_drift_finding: boolean }[] }).invoices[0]!.has_open_drift_finding, false);
  const res = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/waive-stripe-check`, headers: auth(brian), payload: { reason: 'Nothing was raised on this one, for the test.' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'no_drift_finding');
});

test('an invoice with no Stripe payment has nothing to waive', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Nostripe', email: 'nostripe@example.test' });
  const item = await app.db.query<{ amount_cents: number }>(`SELECT pbi.amount_cents FROM price_book_items pbi WHERE pbi.is_active AND pbi.amount_cents > 0 ORDER BY pbi.amount_cents LIMIT 1`);
  const inv = await createInvoice(app, { type: 'staff', id: brian.id, label: brian.fullName }, { contactId: c.id, lines: [{ description: 'Synthetic unpaid', unitCents: item.rows[0]!.amount_cents }], send: false, issued: true });
  const res = await app.inject({ method: 'POST', url: `/invoices/${inv.id}/waive-stripe-check`, headers: auth(brian), payload: { reason: 'There is nothing here to waive, for the test.' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'nothing_to_waive');
});
