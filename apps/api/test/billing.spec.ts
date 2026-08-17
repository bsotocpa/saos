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
import { todayChicago } from '../src/modules/tax/deadlines.ts';

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
  /*
   * INVERTED FOR #48. This asserted 'sent' the moment the return was filed, because
   * `invoiceForFiledEngagement` emailed the client from inside `transitionStage` — an
   * unrollbackable send in the middle of a multi-write sequence. The invoice is now a DRAFT
   * with its delivery queued, and becomes 'sent' when the drain actually sends it.
   *
   * The claim being tested is stronger than before: 'sent' now means a message went, not that
   * a function was called in the right place.
   */
  assert.equal(inv.status, 'draft', 'created, not yet delivered');
  const queued = await app.db.query<{ effect: string }>(
    `SELECT effect FROM outbox WHERE object_id = $1 AND status = 'pending'`, [inv.id]
  );
  assert.equal(queued.rows[0]!.effect, 'invoice.send', 'the delivery is queued with the filing');

  const { drainOutbox } = await import('../src/outbox.ts');
  await drainOutbox(app);
  const delivered = await app.db.query<{ status: string; sent_at: Date | null }>(
    `SELECT status::text AS status, sent_at FROM invoices WHERE id = $1`, [inv.id]
  );
  assert.equal(delivered.rows[0]!.status, 'sent', 'sent once the drain performed it');
  assert.ok(delivered.rows[0]!.sent_at);
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
  // 20 days, not 15. The job compares a timestamptz (`now() - N days`) against
  // `todayChicago()::date - 14 days`, i.e. MIDNIGHT Chicago. Between UTC midnight
  // and Chicago midnight the two calendars disagree by a day, so a 15-day
  // backdate leaves under a day of slack and the comparison flips — this spec
  // failed only in that five-hour window. Size the fixture for the worst
  // timezone offset, not the offset you happened to observe.
  await app.db.query(`UPDATE invoices SET sent_at = now() - interval '20 days' WHERE id = $1`, [invoiceId]);

  // asOf tracks the real clock — the fixture above is now()-relative, so a
  // fixed date here rots as the calendar advances (learned the hard way).
  const asOf = todayChicago();
  const run = await app.inject({ method: 'POST', url: `/jobs/invoice-overdue?asOf=${asOf}`, headers: auth(ana) });
  assert.equal(run.statusCode, 403, 'preparer cannot trigger jobs'); // jobs.run is leadership-only

  const brian = await staffWithToken('brian-bill@example.test', 'ceo');
  const run2 = await app.inject({ method: 'POST', url: `/jobs/invoice-overdue?asOf=${asOf}`, headers: auth(brian) });
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
  const run3 = await app.inject({ method: 'POST', url: `/jobs/invoice-overdue?asOf=${asOf}`, headers: auth(brian) });
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

// ── M26 flow 4: dunning ladder + late fees ───────────────────────────────────

test('dunning ladder: 3 reminders over 10 days → Rene call task → 30-day work pause → payment resumes', async () => {
  const { runDunningJob } = await import('../src/modules/billing/dunning.ts');
  const brian = await staffWithToken('brian-dun@example.test', 'ceo');
  void brian;
  const lila = await makeClient('Dunlila', 'dun-lila@example.test');

  // An engagement + its invoice, overdue as of the ladder start.
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`,
    [lila.contactId]
  );
  const created = await app.inject({
    method: 'POST', url: '/invoices', headers: auth(rene),
    payload: { contactId: lila.contactId, engagementId: eng.rows[0]!.id, lines: [{ code: 'ENTITY_BOI' }] },
  });
  assert.equal(created.statusCode, 201, created.body);
  const invoiceId = created.json().id as string;
  await app.db.query(
    `UPDATE invoices SET status = 'overdue', overdue_since = '2030-01-01' WHERE id = $1`,
    [invoiceId]
  );

  // Attempt 1 (day 0).
  const attempts = async () => (await app.db.query<{ n: number }>(
    `SELECT dunning_attempts AS n FROM invoices WHERE id = $1`, [invoiceId])).rows[0]!.n;
  const mailTo = () => sentMail.filter((m) => m.to === 'dun-lila@example.test' && /reminder|recordatorio/i.test(m.subject)).length;

  await runDunningJob(app, '2030-01-01');
  assert.equal(await attempts(), 1, 'first reminder attempt recorded');
  assert.equal(mailTo(), 1, 'client emailed once');
  // Same day → date-guarded.
  assert.equal((await runDunningJob(app, '2030-01-01')).skipped, true);
  // Day 3: too soon for attempt 2 (spacing is 5 days).
  await runDunningJob(app, '2030-01-04');
  assert.equal(await attempts(), 1, 'attempts are spaced 5 days, not daily');
  // Attempt 2 (day 6) and attempt 3 (day 11) → the call task lands on Rene.
  await runDunningJob(app, '2030-01-07');
  assert.equal(await attempts(), 2);
  await runDunningJob(app, '2030-01-12');
  assert.equal(await attempts(), 3, 'third and final reminder');
  assert.equal(mailTo(), 3, 'exactly three client emails');
  const callTask = await app.db.query<{ assigned_staff_id: string; priority: number; id: string }>(
    `SELECT id, assigned_staff_id, priority FROM tasks WHERE source_type = 'dunning_call' AND source_id = $1`,
    [invoiceId]
  );
  assert.equal(callTask.rows.length, 1);
  assert.equal(callTask.rows[0]!.assigned_staff_id, rene.id);
  assert.equal(callTask.rows[0]!.priority, 2);
  // A fourth reminder never goes out.
  await runDunningJob(app, '2030-01-20');
  assert.equal(await attempts(), 3, 'capped at 3 attempts');
  assert.equal(mailTo(), 3, 'no fourth email');

  // Day 31 → work pauses with a CLIENT-VISIBLE reason.
  await runDunningJob(app, '2030-02-01');
  const paused = await app.db.query<{ work_paused_at: Date | null; work_pause_reason: string }>(
    `SELECT work_paused_at, work_pause_reason FROM engagements WHERE id = $1`,
    [eng.rows[0]!.id]
  );
  assert.ok(paused.rows[0]!.work_paused_at);
  assert.equal(paused.rows[0]!.work_pause_reason, 'account needs attention');
  // Pausing twice is a no-op (the pause timestamp does not move).
  const firstPause = paused.rows[0]!.work_paused_at;
  await runDunningJob(app, '2030-02-02');
  const stillPaused = await app.db.query<{ work_paused_at: Date }>(
    `SELECT work_paused_at FROM engagements WHERE id = $1`, [eng.rows[0]!.id]);
  assert.deepEqual(stillPaused.rows[0]!.work_paused_at, firstPause);

  // Payment lifts the pause and closes the call task.
  const { markInvoicePaid } = await import('../src/modules/billing/service.ts');
  await markInvoicePaid(app, invoiceId, {});
  const resumed = await app.db.query<{ work_paused_at: Date | null }>(
    `SELECT work_paused_at FROM engagements WHERE id = $1`, [eng.rows[0]!.id]
  );
  assert.equal(resumed.rows[0]!.work_paused_at, null, 'payment resumes work');
  const closed = await app.db.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [callTask.rows[0]!.id]);
  assert.equal(closed.rows[0]!.status, 'completed');
});

test('late fees: BLOCKED without a signed disclosure; rate comes from the price book; deposits net first', async () => {
  const { runDunningJob, lateFeeTerms } = await import('../src/modules/billing/dunning.ts');

  // The rate is data, not code.
  const terms = await lateFeeTerms(app);
  assert.deepEqual(terms, { ratePercent: 1.5, graceDays: 30 }, 'rate from LATE_FEE_MONTHLY.percent_rate, grace from its metadata');

  const nora = await makeClient('Feenora', 'fee-nora@example.test');
  const created = await app.inject({
    method: 'POST', url: '/invoices', headers: auth(rene),
    payload: { contactId: nora.contactId, lines: [{ code: 'BIZ_1120S' }] }, // $700.00
  });
  const invoiceId = created.json().id as string;
  const total = created.json().totalCents as number;
  assert.equal(total, 70000);
  await app.db.query(`UPDATE invoices SET status = 'overdue', overdue_since = '2031-01-01' WHERE id = $1`, [invoiceId]);

  // Past the grace period, but NO signed disclosure → refused, and counted.
  const blocked = await runDunningJob(app, '2031-02-05');
  assert.ok(blocked.feesBlockedNoDisclosure >= 1, 'the block is visible in the run record');
  const noFee = await app.db.query<{ late_fee_cents: number }>(`SELECT late_fee_cents FROM invoices WHERE id = $1`, [invoiceId]);
  assert.equal(noFee.rows[0]!.late_fee_cents, 0);

  // Sign a letter carrying the disclosure → the stamp opens the gate. Signing stamps the
  // DISCLOSED RATE with it (finding #25); without it the assessment fails closed.
  await app.db.query(
    `UPDATE contacts SET late_fee_disclosure_signed_at = now(),
            late_fee_disclosed_rate_percent = (SELECT late_fee_rate_percent FROM templates WHERE key = 'engagement_master')
      WHERE id = $1`,
    [nora.contactId]
  );
  // A $100 deposit/credit nets against the balance BEFORE the fee computes.
  await app.db.query(`UPDATE invoices SET credit_cents = 10000 WHERE id = $1`, [invoiceId]);
  const assessed = await runDunningJob(app, '2031-02-06');
  assert.ok(assessed.feesAssessed >= 1);
  const fee = await app.db.query<{ basis_cents: number; rate_percent: string; fee_cents: number }>(
    `SELECT basis_cents, rate_percent::text AS rate_percent, fee_cents FROM invoice_late_fees WHERE invoice_id = $1`,
    [invoiceId]
  );
  assert.equal(fee.rows[0]!.basis_cents, 60000, 'basis is net of the credit ($700 − $100)');
  assert.equal(fee.rows[0]!.fee_cents, 900, '1.5% of $600 = $9.00');
  const invAfter = await app.db.query<{ late_fee_cents: number; total_cents: number }>(
    `SELECT late_fee_cents, total_cents FROM invoices WHERE id = $1`, [invoiceId]
  );
  assert.equal(invAfter.rows[0]!.late_fee_cents, 900, 'itemized on the invoice');
  assert.equal(invAfter.rows[0]!.total_cents, 70900);

  // Not charged twice inside the same 30-day period.
  await runDunningJob(app, '2031-02-20');
  const oneFee = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM invoice_late_fees WHERE invoice_id = $1`, [invoiceId]);
  assert.equal(oneFee.rows[0]!.n, 1, 'monthly, not daily');

  // Kill switch: late_fees OFF suppresses assessment entirely.
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'late_fees'`);
  const disarmed = await runDunningJob(app, '2031-04-01');
  assert.equal(disarmed.feesAssessed, 0, 'kill switch beats everything');
  const stillOneFee = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM invoice_late_fees WHERE invoice_id = $1`, [invoiceId]);
  assert.equal(stillOneFee.rows[0]!.n, 1);
  await app.db.query(`UPDATE automations SET enabled = true WHERE key = 'late_fees'`);
});

/*
 * FINDING #25 (Brian, 2026-08-14). The book line said flat $25/month while Master §3
 * discloses 1.5%/month, so on any past-due balance under $1,667 the book authorised a
 * charge larger than the one every signed client agreed to.
 *
 * Two separate things had to be true, and these test both:
 *   the book states a RATE, not a fixed fee — the shape that made $25 expressible at all;
 *   the charge is capped at what THIS client's signed letter disclosed.
 */
test('#25: the late-fee line is a rate, and a fixed amount cannot sit beside it', async () => {
  const { rows } = await app.db.query<{
    mode: string; percent_rate: string | null; amount_cents: number | null;
  }>(
    `SELECT i.pricing_mode::text AS mode, i.percent_rate, i.amount_cents
       FROM price_book_items i JOIN price_book_versions v ON v.id = i.version_id
      WHERE v.effective_to IS NULL AND i.item_code = 'LATE_FEE_MONTHLY'`
  );
  assert.equal(rows[0]!.mode, 'percent');
  assert.equal(Number(rows[0]!.percent_rate), 1.5, 'conforms to Master §3');
  assert.equal(rows[0]!.amount_cents, null, 'a rate line has no fixed price');

  // The CHECK is what stops $25 being written back onto it.
  const versionId = (
    await app.db.query<{ id: string }>(`SELECT id FROM price_book_versions WHERE effective_to IS NULL LIMIT 1`)
  ).rows[0]!.id;
  await assert.rejects(
    app.db.query(
      `INSERT INTO price_book_items (version_id, item_code, service_line, name_en, name_es,
                                     pricing_mode, percent_rate, amount_cents)
       VALUES ($1, 'V25_BOTH', 'specialized_cpa', 'x', 'x', 'percent', 1.5, 2500)`,
      [versionId]
    ),
    'a percent line may not also carry a fixed amount'
  );

  // And the Master declares the rate it discloses, so the two can be compared.
  const master = await app.db.query<{ rate: string | null }>(
    `SELECT late_fee_rate_percent AS rate FROM templates WHERE key = 'engagement_master'`
  );
  assert.equal(Number(master.rows[0]!.rate), 1.5, 'the disclosed rate is machine-readable');
});

test('#25: a client is never charged above the rate THEIR signed letter disclosed', async () => {
  const { runDunningJob } = await import('../src/modules/billing/dunning.ts');
  const cappy = await makeClient('Feecap', 'fee-cap@example.test');
  const created = await app.inject({
    method: 'POST', url: '/invoices', headers: auth(rene),
    payload: { contactId: cappy.contactId, lines: [{ code: 'BIZ_1120S' }] }, // $700.00
  });
  const invoiceId = created.json().id as string;
  await app.db.query(
    `UPDATE invoices SET status = 'overdue', overdue_since = '2032-01-01' WHERE id = $1`,
    [invoiceId]
  );

  // This client signed an OLDER letter disclosing 1%. The book says 1.5%.
  await app.db.query(
    `UPDATE contacts SET late_fee_disclosure_signed_at = now(), late_fee_disclosed_rate_percent = 1.0
      WHERE id = $1`,
    [cappy.contactId]
  );

  const run = await runDunningJob(app, '2032-02-06');
  assert.ok(run.feesCappedByDisclosure >= 1, 'the cap is reported, not silent');

  const fee = await app.db.query<{
    rate_percent: string; book_rate_percent: string; disclosed_rate_percent: string; fee_cents: number;
  }>(
    `SELECT rate_percent::text, book_rate_percent::text, disclosed_rate_percent::text, fee_cents
       FROM invoice_late_fees WHERE invoice_id = $1`,
    [invoiceId]
  );
  const f = fee.rows[0]!;
  assert.equal(Number(f.rate_percent), 1.0, 'charged at the DISCLOSED rate');
  assert.equal(Number(f.book_rate_percent), 1.5, 'and the book rate is recorded beside it');
  assert.equal(Number(f.disclosed_rate_percent), 1.0);
  // 1% of $700, not 1.5% of $700 ($10.50). The whole finding in one number.
  assert.equal(f.fee_cents, 700, '1% of $700 = $7.00');
});

test('#25: an unprovable disclosed rate charges nothing rather than guessing', async () => {
  const { runDunningJob } = await import('../src/modules/billing/dunning.ts');
  const vague = await makeClient('Feevague', 'fee-vague@example.test');
  const created = await app.inject({
    method: 'POST', url: '/invoices', headers: auth(rene),
    payload: { contactId: vague.contactId, lines: [{ code: 'BIZ_1120S' }] },
  });
  const invoiceId = created.json().id as string;
  await app.db.query(
    `UPDATE invoices SET status = 'overdue', overdue_since = '2033-01-01' WHERE id = $1`,
    [invoiceId]
  );
  // Signed the disclosure, but the rate was never captured — a pre-#25 signature.
  await app.db.query(
    `UPDATE contacts SET late_fee_disclosure_signed_at = now(), late_fee_disclosed_rate_percent = NULL
      WHERE id = $1`,
    [vague.contactId]
  );

  const run = await runDunningJob(app, '2033-02-06');
  assert.ok(run.feesBlockedNoDisclosedRate >= 1, 'counted, not silently skipped');
  const charged = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM invoice_late_fees WHERE invoice_id = $1`, [invoiceId]);
  assert.equal(charged.rows[0]!.n, 0, 'we cannot prove what they agreed to, so we charge nothing');
});

/*
 * The invoice email pointed at the portal HOME (Brian's template audit, 2026-08-15).
 * "Your invoice is ready in your portal" followed by a link to a dashboard, leaving the
 * client to go find it — and the copy claimed "pay securely with one click", which was
 * never true because paying requires a signed-in session.
 */
test('the invoice email deep-links to THAT invoice, and no longer promises one click', async () => {
  const deep = await makeClient('Feedeep', 'fee-deep@example.test');
  const before = sentMail.length;
  const created = await app.inject({
    method: 'POST', url: '/invoices', headers: auth(rene),
    payload: { contactId: deep.contactId, send: true, lines: [{ description: 'Work', unitCents: 12345 }] },
  });
  assert.equal(created.statusCode, 201, created.body);
  const invoiceId = created.json().id as string;

  const mail = sentMail.slice(before).find((m) => m.to === 'fee-deep@example.test');
  assert.ok(mail, 'the invoice email went out');
  // Plain substring, not a RegExp: the URL contains '?' and the id contains hyphens, and
  // escaping those through a template literal is how this assertion silently passed for
  // the wrong reason the first time.
  assert.ok(
    mail.text.includes(`/invoices?invoice=${invoiceId}`),
    `the link names this invoice, not the portal root — got: ${mail.text.slice(0, 200)}`
  );
  assert.doesNotMatch(mail.text, /one click/i, 'and no longer claims a click count it cannot deliver');
  // A client who is signed out used to hit a dead end here — the same failure as #21.
  assert.match(mail.text, /sign in/i, 'it says what to do if asked to sign in');
});
