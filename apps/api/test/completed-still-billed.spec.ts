// DECISION 1, companion (2026-09-10, Brian's ruling): `completed` stays outside the 0085
// invariant — a final-fee invoice is issued at filing and collected after the work is done.
// So the collection machinery must keep seeing invoices on completed engagements: the
// overdue flip (aging), dunning and late fees, and the nightly Stripe drift check.
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import type { StripeAdapter } from '../src/modules/billing/stripe.ts';
import { createTestConfig, makeContact, makeStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { closeEngagement } from '../src/modules/engagements/close.ts';
import { runInvoiceOverdueJob } from '../src/modules/billing/service.ts';
import { runDunningJob, lateFeeTerms } from '../src/modules/billing/dunning.ts';
import { runStripeDriftCheckJob } from '../src/modules/billing/drift.ts';
import { addDays, todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let ceoId = '';
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const seen: string[] = [];
const stripe: StripeAdapter = {
  mode: 'stub', keyMode: null,
  async createCheckoutSession(input) { return { id: `cs_c_${input.invoiceId}`, url: 'https://checkout.stripe.example/c' }; },
  async retrieveCheckoutSession() { return { status: 'open', paymentStatus: 'unpaid' }; },
  parseWebhookEvent() { throw new Error('not used'); },
  async listRefunds() { return []; },
  async expireCheckoutSession() { /* nothing */ },
  async retrieveCharge(pi) { seen.push(pi); return { refunded: false, amountRefundedCents: 0, disputed: false }; },
};
const today = todayChicago();
const T = (n: number) => addDays(today, n);
const actor = () => ({ id: ceoId, email: 'ceo-completed@example.test', fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

/** A completed engagement with one invoice in the given state attached to it. */
async function completedWith(status: string, opts: { sentOn?: string; overdueSince?: string; pi?: string }) {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Completed${seen.length}${Math.random().toString(36).slice(2, 6)}`, email: `completed-${Math.random().toString(36).slice(2, 8)}@example.test` });
  await app.db.query(`UPDATE contacts SET late_fee_disclosure_signed_at = now(), late_fee_disclosed_rate_percent = (SELECT late_fee_rate_percent FROM templates WHERE key = 'engagement_master') WHERE id = $1`, [c.id]);
  const e = await createEngagement(app, actor(), { contactId: c.id, serviceLine: 'bookkeeping', title: 'Done, invoice open', status: 'active' }, {});
  const { rows } = await app.db.query<{ id: string; invoice_number: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, engagement_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at, overdue_since, paid_at, stripe_payment_intent_id)
     VALUES ($1, $2, $3, $4::invoice_status, 70000, 70000, $5, ($6::date)::timestamptz, $7::date, CASE WHEN $4 = 'paid' THEN now() END, $8) RETURNING id, invoice_number`,
    [`SYN-CMP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, c.id, e.id, status, status === 'paid' ? 70000 : 0, opts.sentOn ?? today, opts.overdueSince ?? null, opts.pi ?? null]);
  const closed = await closeEngagement(app, e.id, { outcome: 'completed' }, { type: 'system', label: 'test' });
  assert.equal(closed.outcome, 'completed');
  return { contactId: c.id, engagementId: e.id, invoiceId: rows[0]!.id, number: rows[0]!.invoice_number };
}

before(async () => {
  config = await createTestConfig('completedbilled');
  app = buildServer(config, { mailer: silentMailer, stripe });
  await app.ready();
  ceoId = (await makeStaff(app.db, config, { email: 'ceo-completed@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567' })).id;
});

after(async () => {
  await app.close();
});

test('aging: a sent invoice on a completed engagement still flips to overdue', async () => {
  const x = await completedWith('sent', { sentOn: T(-15) });
  await runInvoiceOverdueJob(app, today);
  const row = (await app.db.query<{ status: string; overdue_since: string }>(`SELECT status::text AS status, overdue_since::text AS overdue_since FROM invoices WHERE id = $1`, [x.invoiceId])).rows[0]!;
  assert.equal(row.status, 'overdue');
  assert.equal(row.overdue_since, today);
});

test('dunning and late fees: an overdue invoice on a completed engagement is chased and assessed', async () => {
  const terms = (await lateFeeTerms(app))!;
  const x = await completedWith('overdue', { overdueSince: T(-(terms.graceDays + 1)) });
  const run = await runDunningJob(app, today);
  assert.equal(run.skipped, false);
  const fees = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM invoice_late_fees WHERE invoice_id = $1`, [x.invoiceId]);
  assert.equal(Number(fees.rows[0]!.n), 1, 'the fee is assessed on a completed engagement\'s invoice');
  const attempts = (await app.db.query<{ a: number }>(`SELECT dunning_attempts AS a FROM invoices WHERE id = $1`, [x.invoiceId])).rows[0]!;
  assert.ok(attempts.a >= 1, 'and it is on the dunning ladder');
});

test('drift: a paid invoice on a completed engagement is checked against Stripe', async () => {
  seen.length = 0;
  const x = await completedWith('paid', { pi: 'pi_completed_engagement' });
  const run = await runStripeDriftCheckJob(app, today);
  assert.equal(run.skipped, false);
  assert.ok(seen.includes('pi_completed_engagement'), `the nightly check asked Stripe about ${x.number}`);
});
