// M26 flows 6 + 7 "Prove it".
//
// Flow 6 — grant vouchering: STATUS TRACKING ONLY. Periods become owned work
// items, the funder deadline escalates at T-7 and again once it passes,
// reimbursement closes the work, and NOTHING in the module produces a file.
//
// Flow 7 — stalled-onboarding rescue: one client-visible to-do per pipeline
// stage (which is what arms the existing ladder), and at Day 60 Brian gets a
// decision with the deposit HELD AS CREDIT — never auto-refunded.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { runVoucherReminderJob } from '../src/modules/grants/vouchers.ts';
import { runOnboardingRescueJob, stageOf } from '../src/modules/portal-auth/onboarding-rescue.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('grants');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-grants@example.test', 'ceo');
  await makeStaff(app.db, config, {
    email: 'rene-grants@example.test', name: 'Synthetic Rene', role: 'comms_billing',
    password: 'comms_billing-password-123456',
  });
});

after(async () => {
  await app.close();
});

// ── flow 6 ───────────────────────────────────────────────────────────────────

test('vouchering: periods are owned work items, T-7 and overdue escalate, reimbursement closes it', async () => {
  const grant = await app.db.query<{ id: string }>(
    `INSERT INTO grants_received (funder, program, status, lead_staff_id)
     VALUES ('Synthetic Foundation', 'Small Business Fund', 'approved', $1) RETURNING id`,
    [brian.id]
  );
  const grantId = grant.rows[0]!.id;

  const created = await app.inject({
    method: 'POST', url: '/grant-vouchers', headers: auth(brian),
    payload: { grantId, periodLabel: '2027-Q1', funderDueDate: '2027-04-30', amountCents: 500000 },
  });
  assert.equal(created.statusCode, 201, created.body);
  const periodId = created.json().id as string;

  // The period is a task on the owner's list (never a module-local to-do).
  const task = await app.db.query<{ id: string; assigned_staff_id: string; due_date: string }>(
    `SELECT id, assigned_staff_id, due_date::text AS due_date FROM tasks
     WHERE source_type = 'voucher_period' AND source_id = $1`,
    [periodId]
  );
  assert.equal(task.rows.length, 1);
  assert.equal(task.rows[0]!.assigned_staff_id, brian.id);
  assert.equal(task.rows[0]!.due_date, '2027-04-30', 'task clocks to the funder deadline');

  // Duplicate period label is idempotent (no second task, no second row).
  const dupe = await app.inject({
    method: 'POST', url: '/grant-vouchers', headers: auth(brian),
    payload: { grantId, periodLabel: '2027-Q1', funderDueDate: '2027-04-30' },
  });
  assert.equal(dupe.statusCode, 200, dupe.body);
  assert.equal(dupe.json().id, periodId);

  // Too early: nothing fires 30 days out.
  const early = await runVoucherReminderJob(app, '2027-03-30');
  assert.equal(early.upcoming, 0);
  assert.equal(early.overdue, 0);
  // T-7 warns once (notifyOnce dedupes across days).
  const warn = await runVoucherReminderJob(app, '2027-04-25');
  assert.equal(warn.upcoming, 1);
  assert.equal((await runVoucherReminderJob(app, '2027-04-26')).upcoming, 0, 'warned once, not daily');
  const note = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'voucher_due_soon' AND related_object_id = $1`,
    [periodId]
  );
  assert.equal(note.rows[0]!.n, 1);

  // Past the funder date → critical, once.
  const late = await runVoucherReminderJob(app, '2027-05-01');
  assert.equal(late.overdue, 1);
  assert.equal((await runVoucherReminderJob(app, '2027-05-02')).overdue, 0);

  // Status walk: due → in progress → submitted → reimbursed.
  for (const status of ['in_progress', 'submitted']) {
    const res = await app.inject({
      method: 'PATCH', url: `/grant-vouchers/${periodId}`, headers: auth(brian), payload: { status },
    });
    assert.equal(res.statusCode, 200, res.body);
  }
  const submitted = await app.db.query<{ submitted_at: Date | null; status: string }>(
    `SELECT submitted_at, status FROM grant_voucher_periods WHERE id = $1`, [periodId]
  );
  assert.ok(submitted.rows[0]!.submitted_at, 'submission stamped');
  // Submitted periods leave the T-7/overdue sweep.
  assert.equal((await runVoucherReminderJob(app, '2027-05-03')).overdue, 0);

  // Board shows open periods; reimbursement removes it and closes the task.
  const boardBefore = await app.inject({ method: 'GET', url: '/grant-vouchers', headers: auth(brian) });
  assert.ok(boardBefore.json().periods.some((p: { id: string }) => p.id === periodId));

  await app.inject({
    method: 'PATCH', url: `/grant-vouchers/${periodId}`, headers: auth(brian), payload: { status: 'reimbursed' },
  });
  const closed = await app.db.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [task.rows[0]!.id]);
  assert.equal(closed.rows[0]!.status, 'completed', 'money landed → work item done');
  const boardAfter = await app.inject({ method: 'GET', url: '/grant-vouchers', headers: auth(brian) });
  assert.equal(boardAfter.json().periods.some((p: { id: string }) => p.id === periodId), false);
  assert.equal(boardAfter.json().byStatus.reimbursed, 1);
});

test('vouchering module generates NO files — status tracking only (hard rule)', async () => {
  // The rule is architectural: assert there is no export/generate/submit route
  // anywhere on the voucher surface, so a future "helpful" addition trips this.
  const routes = app.printRoutes({ commonPrefix: false });
  const voucherLines = routes
    .split('\n')
    .filter((l) => l.includes('grant-voucher'));
  assert.ok(voucherLines.length > 0, 'voucher routes exist');
  for (const line of voucherLines) {
    assert.ok(
      !/export|download|generate|submit|file/i.test(line),
      `voucher surface must not produce files: ${line}`
    );
  }
});

// ── flow 7 ───────────────────────────────────────────────────────────────────

test('onboarding rescue: one client-visible to-do per stage (arming the ladder), Day-60 decision holds the deposit as credit', async () => {
  const stuck = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Stuckdep', email: 'stuck-dep@example.test' });
  // Started 70 days ago, deposit paid, nothing else done → 'deposit' stage.
  await app.db.query(
    `INSERT INTO portal_onboarding (contact_id, variant, created_at, deposit_paid_at, deposit_amount_cents)
     VALUES ($1, 'new', now() - interval '70 days', now() - interval '70 days', 25000)`,
    [stuck.id]
  );
  // A second client mid-pipeline (docs stage), only 5 days old.
  const midway = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Midway', email: 'midway@example.test' });
  await app.db.query(
    `INSERT INTO portal_onboarding (contact_id, variant, created_at, step_confirm_info_at, step_sign_docs_at, step_upload_prior_return_at)
     VALUES ($1, 'new', now() - interval '5 days', now(), now(), now())`,
    [midway.id]
  );

  const today = new Date().toISOString().slice(0, 10);
  const run = await runOnboardingRescueJob(app, today);
  assert.equal(run.skipped, false);
  assert.equal(run.byStage.deposit, 1);
  assert.equal(run.byStage.docs, 1);
  assert.equal(run.nudged, 2, 'one client-visible to-do each');
  assert.equal(run.stalled, 1, 'only the 70-day-old one is stalled');

  // The to-dos are CLIENT-VISIBLE, which is what arms the ladder.
  const todo = await app.db.query<{ client_visible: boolean; waiting_since: Date | null; source_type: string }>(
    `SELECT client_visible, waiting_since, source_type FROM tasks WHERE contact_id = $1 AND source_type LIKE 'onboarding_%'`,
    [stuck.id]
  );
  const nudge = todo.rows.find((r) => r.source_type === 'onboarding_deposit');
  assert.ok(nudge, 'stage to-do created');
  assert.equal(nudge!.client_visible, true);
  assert.ok(nudge!.waiting_since, 'ladder clock armed by the client-visible task');

  // Day-60 decision: Brian owns it, urgent, and the deposit is HELD AS CREDIT.
  const stalledTask = await app.db.query<{ assigned_staff_id: string; priority: number; description: string }>(
    `SELECT assigned_staff_id, priority, description FROM tasks
     WHERE source_type = 'onboarding_stalled' AND source_id = $1`,
    [stuck.id]
  );
  assert.equal(stalledTask.rows.length, 1);
  assert.equal(stalledTask.rows[0]!.assigned_staff_id, brian.id);
  assert.equal(stalledTask.rows[0]!.priority, 2);
  assert.match(stalledTask.rows[0]!.description, /HELD AS CREDIT/);
  assert.match(stalledTask.rows[0]!.description, /never\s+auto-refunds/i);
  assert.match(stalledTask.rows[0]!.description, /\$250\.00/, 'the actual deposit amount is stated');

  // No money action was taken anywhere — the deposit row is untouched.
  const deposit = await app.db.query<{ deposit_amount_cents: number; stalled_flagged_at: Date | null }>(
    `SELECT deposit_amount_cents, stalled_flagged_at FROM portal_onboarding WHERE contact_id = $1`,
    [stuck.id]
  );
  assert.equal(deposit.rows[0]!.deposit_amount_cents, 25000, 'deposit is never auto-refunded or zeroed');
  assert.ok(deposit.rows[0]!.stalled_flagged_at);

  // Same-day rerun is date-guarded; a later run never re-flags or re-nudges.
  assert.equal((await runOnboardingRescueJob(app, today)).skipped, true);
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const second = await runOnboardingRescueJob(app, tomorrow);
  assert.equal(second.nudged, 0, 'one live to-do per stage, not one per day');
  assert.equal(second.stalled, 0, 'flagged once');

  // Staff pipeline board reflects the stages.
  const board = await app.inject({ method: 'GET', url: '/onboarding-pipeline', headers: auth(brian) });
  assert.equal(board.statusCode, 200, board.body);
  const stuckRow = board.json().onboarding.find((o: { contactId: string }) => o.contactId === stuck.id);
  assert.equal(stuckRow.stage, 'deposit');
  assert.equal(stuckRow.depositCents, 25000);
  assert.ok(stuckRow.stalledFlaggedAt);

  // Completing onboarding takes it off the board entirely.
  await app.db.query(`UPDATE portal_onboarding SET completed_at = now() WHERE contact_id = $1`, [midway.id]);
  const after = await app.inject({ method: 'GET', url: '/onboarding-pipeline', headers: auth(brian) });
  assert.equal(after.json().onboarding.some((o: { contactId: string }) => o.contactId === midway.id), false);
});

test('stage derivation walks the pipeline in order', () => {
  const base = {
    contact_id: 'x', first_name: 'A', last_name: 'B', variant: 'new', created_at: new Date(),
    deposit_paid_at: null, deposit_amount_cents: null,
    step_confirm_info_at: null, step_sign_docs_at: null, step_upload_prior_return_at: null,
    completed_at: null, stalled_flagged_at: null,
  };
  assert.equal(stageOf(base), 'deposit');
  assert.equal(stageOf({ ...base, step_confirm_info_at: new Date() }), 'questionnaire');
  assert.equal(stageOf({ ...base, step_confirm_info_at: new Date(), step_upload_prior_return_at: new Date() }), 'docs');
  assert.equal(stageOf({ ...base, completed_at: new Date() }), 'complete');
});
