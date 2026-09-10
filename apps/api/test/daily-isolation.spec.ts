// 2026-09-10, the first daily run under the live key. The Stripe drift check threw on a payment
// the live key could not see (SA-2026-0001, paid under the test key on 08-13); the jobs ran as
// one straight line, so review requests, event reminders, the perfection clock, the escalation
// ladder, the health refresh — and every-tick payment reconciliation — did not run, and would not
// have on any tick until the throw was fixed. Two rules now: a payment Stripe cannot verify is a
// FINDING (a task, counted), never a throw; and every job runs in isolation — a failure is logged,
// audited as job.failed, and the next job runs. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import type { StripeAdapter } from '../src/modules/billing/stripe.ts';
import { createTestConfig, makeContact } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { runStripeDriftCheckJob } from '../src/modules/billing/drift.ts';
import { DAILY_JOBS, runJobsIsolated } from '../src/jobs/daily.ts';

let app: FastifyInstance;
let config: Config;
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };

/** A Stripe that cannot see one payment intent — the live key looking at a test-mode payment. */
const stripe: StripeAdapter = {
  mode: 'stub',
  keyMode: null,
  async createCheckoutSession(input) { return { id: `cs_iso_${input.invoiceId}`, url: 'https://checkout.stripe.example/iso' }; },
  async retrieveCheckoutSession() { return { status: 'open', paymentStatus: 'unpaid' }; },
  parseWebhookEvent() { throw new Error('not used here'); },
  async listRefunds() { return []; },
  async expireCheckoutSession() { /* nothing */ },
  async retrieveCharge(paymentIntentId) {
    if (paymentIntentId === 'pi_test_mode_from_august') throw new Error("No such payment_intent: 'pi_test_mode_from_august'");
    return { refunded: false, amountRefundedCents: 0, disputed: false };
  },
};

before(async () => {
  config = await createTestConfig('dailyiso');
  app = buildServer(config, { mailer: silentMailer, stripe });
  await app.ready();
});

after(async () => {
  await app.close();
});

test('the drift check: a payment Stripe cannot see becomes a task and a count, and the run finishes', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Unverifiable', email: 'unverifiable@example.test' });
  const mk = async (n: string, pi: string) => (await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at, paid_at, stripe_payment_intent_id)
     VALUES ($1, $2, 'paid', 10000, 10000, 10000, now(), now(), $3) RETURNING id`, [n, c.id, pi])).rows[0]!.id;
  const stale = await mk('SYN-ISO-0001', 'pi_test_mode_from_august');
  await mk('SYN-ISO-0002', 'pi_live_fine');

  const run = await runStripeDriftCheckJob(app, '2026-09-10');
  assert.equal(run.skipped, false);
  assert.equal(run.checked, 2, 'the loop reached both');
  assert.equal(run.unverifiable, 1);
  assert.equal(run.drifted, 0, 'the one Stripe can see agrees');
  const task = await app.db.query<{ title: string }>(`SELECT title FROM tasks WHERE source_type = 'stripe_drift' AND source_id = $1`, [stale]);
  assert.equal(task.rows.length, 1);
  assert.match(task.rows[0]!.title, /cannot verify SYN-ISO-0001/);
  const record = await app.db.query<{ details: { unverifiable: Array<{ invoiceNumber: string }> } }>(`SELECT details FROM audit_log WHERE action = 'ops.stripe_drift_checked' AND details->>'day' = '2026-09-10'`);
  assert.equal(record.rows.length, 1, 'the run record was written — the run finished');
  assert.deepEqual(record.rows[0]!.details.unverifiable.map((u) => u.invoiceNumber), ['SYN-ISO-0001']);
});

test('one job\'s failure is that job\'s: logged, audited as job.failed, and the next job still runs', async () => {
  const ran: string[] = [];
  const { ran: ok, failed } = await runJobsIsolated(app, '2026-09-10', [
    { name: 'first', run: async () => { ran.push('first'); return { skipped: false }; } },
    { name: 'breaks', run: async () => { throw new Error('No such payment_intent: synthetic'); } },
    { name: 'third', run: async () => { ran.push('third'); return { skipped: false }; } },
  ]);
  assert.deepEqual(ran, ['first', 'third'], 'the job after the failure ran');
  assert.deepEqual(ok, ['first', 'third']);
  assert.deepEqual(failed, ['breaks']);
  const audit = await app.db.query<{ details: { job: string; error: string } }>(`SELECT details FROM audit_log WHERE action = 'job.failed' AND object_id = 'breaks'`);
  assert.equal(audit.rows.length, 1);
  assert.match(audit.rows[0]!.details.error, /synthetic/);
});

test('the real job list still carries every job the straight line ran, with reconciliation after the drift check', () => {
  const names = DAILY_JOBS.map((j) => j.name);
  for (const expected of ['extension_decision_list', 'entity_compliance', 'document_chase', 'invoice_overdue', 'ar_dunning', 'voucher_reminders', 'quote_expiry', 'stripe_drift', 'review_requests', 'event_reminders', 'perfection_clock', 'escalation_ladder', 'outbox_drain', 'notice_escalations', 'dependency_probe', 'document_rescan', 'payment_reconcile']) {
    assert.ok(names.includes(expected), `${expected} is on the list`);
  }
  assert.ok(names.indexOf('stripe_drift') < names.indexOf('payment_reconcile'), 'the order that failed on 2026-09-10 — and no longer can');
});
