// M9 "Prove it": alert-timing tests (48h unactioned, 14-day deadline
// escalation, both idempotent), auto response-deadline + role-based routing,
// annual-report T-60/T-30 reminders, PLLC pipeline. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { nextAnnualReportDueDate } from '../src/modules/entity/service.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };   // ceo
let jackson: TestStaff & { token: string }; // ed_coo
let ana: TestStaff & { token: string };     // tax_preparer (notice handler role)
let laura: TestStaff & { token: string };   // va_entity

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

async function makeClient(last: string, email: string, language: 'en' | 'es' = 'en'): Promise<string> {
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, language, soto_status)
     VALUES ('Synthetic', $1, $2, $3, 'active') RETURNING id`,
    [last, email, language]
  );
  return rows[0]!.id;
}

// relatedId scopes the count to ONE notice — earlier tests in this suite
// create notices whose auto-deadlines (notice date + 30d) drift into the
// escalation window as the real calendar advances; global counts rot.
async function notifications(type: string, staffId?: string, relatedId?: string): Promise<number> {
  const clauses = [`type = $1`];
  const params: unknown[] = [type];
  if (staffId) { params.push(staffId); clauses.push(`staff_id = $${params.length}`); }
  if (relatedId) { params.push(relatedId); clauses.push(`related_object_id = $${params.length}`); }
  const { rows } = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM notifications WHERE ${clauses.join(' AND ')}`,
    params
  );
  return rows[0]!.n;
}

before(async () => {
  config = await createTestConfig('not');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  brian = await staffWithToken('brian-not@example.test', 'ceo');
  jackson = await staffWithToken('jackson-not@example.test', 'ed_coo');
  ana = await staffWithToken('ana-not@example.test', 'tax_preparer');
  laura = await staffWithToken('laura-not@example.test', 'va_entity');
});

after(async () => {
  await app.close();
});

test('notice creation: auto response-deadline (notice date + 30) and role-routed handler alert', async () => {
  const client = await makeClient('Noticed', 'noticed@example.test');
  const res = await app.inject({
    method: 'POST', url: '/irs-notices', headers: auth(ana),
    payload: { contactId: client, noticeType: 'CP2000', taxYear: 2024, noticeDate: '2026-07-01' },
  });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().responseDeadline, '2026-07-31', 'auto deadline = notice date + 30');
  assert.equal(res.json().handlerStaffId, ana.id, 'routed to the tax_preparer role (Ana-Maria)');
  assert.equal(await notifications('irs_notice_new', ana.id), 1);
});

test('status change out of received stamps first_actioned_at once', async () => {
  const client = await makeClient('Actioned', 'actioned@example.test');
  const created = await app.inject({
    method: 'POST', url: '/irs-notices', headers: auth(ana),
    payload: { contactId: client, noticeType: 'CP14', noticeDate: '2026-07-01' },
  });
  const id = created.json().id as string;

  await app.inject({
    method: 'PATCH', url: `/irs-notices/${id}`, headers: auth(ana),
    payload: { status: 'under_review' },
  });
  const first = await app.db.query(`SELECT first_actioned_at FROM irs_notices WHERE id = $1`, [id]);
  assert.ok(first.rows[0].first_actioned_at);

  const stamp = first.rows[0].first_actioned_at;
  await app.inject({
    method: 'PATCH', url: `/irs-notices/${id}`, headers: auth(ana),
    payload: { status: 'response_drafted' },
  });
  const second = await app.db.query(`SELECT first_actioned_at FROM irs_notices WHERE id = $1`, [id]);
  assert.deepEqual(second.rows[0].first_actioned_at, stamp, 'first_actioned_at never moves');
});

test('escalations: 48h unactioned → Brian+Jackson; <14d deadline → Brian; both idempotent', async () => {
  const client = await makeClient('Escalate', 'escalate@example.test');

  // A: unactioned, received 3 days ago.
  const a = await app.inject({
    method: 'POST', url: '/irs-notices', headers: auth(ana),
    payload: { contactId: client, noticeType: 'CP504', noticeDate: '2026-06-20', responseDeadline: '2099-01-01' },
  });
  const aId = a.json().id as string;
  await app.db.query(`UPDATE irs_notices SET received_at = now() - interval '3 days' WHERE id = $1`, [aId]);

  // B: actioned promptly, deadline in 10 days → deadline escalation only.
  const b = await app.inject({
    method: 'POST', url: '/irs-notices', headers: auth(ana),
    payload: { contactId: client, noticeType: 'CP2000' },
  });
  const bId = b.json().id as string;
  await app.inject({ method: 'PATCH', url: `/irs-notices/${bId}`, headers: auth(ana), payload: { status: 'under_review' } });
  await app.db.query(`UPDATE irs_notices SET response_deadline = CURRENT_DATE + 10 WHERE id = $1`, [bId]);

  // C: actioned, deadline far out → nothing fires.
  const c = await app.inject({
    method: 'POST', url: '/irs-notices', headers: auth(ana),
    payload: { contactId: client, noticeType: 'CP12' },
  });
  const cId = c.json().id as string;
  await app.inject({ method: 'PATCH', url: `/irs-notices/${cId}`, headers: auth(ana), payload: { status: 'under_review' } });
  await app.db.query(`UPDATE irs_notices SET response_deadline = CURRENT_DATE + 60 WHERE id = $1`, [cId]);

  const run = await app.inject({ method: 'POST', url: '/jobs/notice-escalations', headers: auth(brian) });
  assert.equal(run.statusCode, 200, run.body);
  assert.ok(run.json().unactioned >= 1);
  assert.ok(run.json().deadline >= 1);

  // A → both leaders alerted.
  assert.equal(await notifications('irs_notice_unactioned', brian.id, aId), 1);
  assert.equal(await notifications('irs_notice_unactioned', jackson.id, aId), 1);
  // B → Brian only, status escalated + stamped.
  assert.equal(await notifications('irs_notice_deadline_escalation', brian.id, bId), 1);
  const bRow = await app.db.query(`SELECT status, escalated_at FROM irs_notices WHERE id = $1`, [bId]);
  assert.equal(bRow.rows[0].status, 'escalated');
  assert.ok(bRow.rows[0].escalated_at);
  // C untouched.
  const cRow = await app.db.query(`SELECT status, escalated_at FROM irs_notices WHERE id = $1`, [cId]);
  assert.equal(cRow.rows[0].escalated_at, null);

  // Re-run: nothing duplicates.
  await app.inject({ method: 'POST', url: '/jobs/notice-escalations', headers: auth(brian) });
  assert.equal(await notifications('irs_notice_unactioned', brian.id, aId), 1);
  assert.equal(await notifications('irs_notice_deadline_escalation', brian.id, bId), 1);
});

test('annual-report due-date rule: IL = first day of anniversary month, strictly future', () => {
  assert.equal(nextAnnualReportDueDate('IL', '2024-09-10', '2026-07-03'), '2026-09-01');
  assert.equal(nextAnnualReportDueDate('IL', '2024-09-10', '2026-09-01'), '2027-09-01'); // not <= from
  assert.equal(nextAnnualReportDueDate('IL', '2024-01-20', '2026-07-03'), '2027-01-01');
  assert.equal(nextAnnualReportDueDate('WI', '2024-09-10', '2026-07-03'), '2026-09-10'); // default: anniversary date
});

test('entity compliance: T-60 Laura reminder + task, T-30 client email (ES), filed rolls the date', async () => {
  const owner = await makeClient('Duena', 'duena@example.test', 'es');
  const biz = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, entity_type, state) VALUES ('Synthetic Flores LLC', 'llc', 'IL') RETURNING id`
  );
  const bizId = biz.rows[0]!.id;
  await app.db.query(
    `INSERT INTO business_members (business_id, contact_id, member_role, is_primary) VALUES ($1, $2, 'owner', true)`,
    [bizId, owner]
  );

  const created = await app.inject({
    method: 'POST', url: '/entity-compliance', headers: auth(laura),
    payload: { businessId: bizId, formationDate: '2024-09-10', annualReportDueDate: '2026-09-01' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const ecId = created.json().id as string;

  // T-60 (2026-07-03): Laura notification + task.
  const t60 = await app.inject({ method: 'POST', url: '/jobs/entity-compliance?asOf=2026-07-03', headers: auth(brian) });
  assert.equal(t60.json().staffReminders, 1, t60.body);
  assert.equal(await notifications('annual_report_t60', laura.id), 1);
  const task = await app.db.query(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'annual_report' AND assigned_staff_id = $1`,
    [laura.id]
  );
  assert.equal(task.rows[0].n, 1);

  // T-30 (2026-08-02): Spanish client email.
  const t30 = await app.inject({ method: 'POST', url: '/jobs/entity-compliance?asOf=2026-08-02', headers: auth(brian) });
  assert.equal(t30.json().clientReminders, 1, t30.body);
  const mail = sentMail.find((m) => m.to === 'duena@example.test');
  assert.ok(mail, 'client reminder sent');
  assert.match(mail.subject, /informe anual/i);
  assert.match(mail.text, /Synthetic Flores LLC/);

  // Same-date re-run skips (date guard).
  const rerun = await app.inject({ method: 'POST', url: '/jobs/entity-compliance?asOf=2026-08-02', headers: auth(brian) });
  assert.equal(rerun.json().skipped, true);

  // Filed → history row + due date rolls to next IL period.
  const filed = await app.inject({
    method: 'POST', url: `/entity-compliance/${ecId}/filed`, headers: auth(laura),
    payload: { filedDate: '2026-08-20' },
  });
  assert.equal(filed.statusCode, 200, filed.body);
  assert.equal(filed.json().nextDueDate, '2027-09-01');
  const filings = await app.db.query(
    `SELECT period_year, status FROM annual_report_filings WHERE entity_compliance_id = $1`,
    [ecId]
  );
  assert.equal(filings.rows.length, 1);
  assert.equal(filings.rows[0].period_year, 2026);
  assert.equal(filings.rows[0].status, 'filed');
});

test('PLLC pipeline: flag routes to Laura + advisory flag to Brian; license verification step', async () => {
  const therapist = await makeClient('Therapist', 'therapist@example.test');
  const created = await app.inject({
    method: 'POST', url: '/pllc-conversions', headers: auth(laura),
    payload: { contactId: therapist, licenseType: 'LCPC', currentEntityType: 'llc', detectedVia: 'manual' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;

  assert.equal(await notifications('pllc_conversion_flagged', laura.id), 1, 'routed to Laura (va_entity)');
  assert.equal(await notifications('pllc_advisory_flag', brian.id), 1, 'advisory flag to Brian');

  const list = await app.inject({ method: 'GET', url: '/pllc-conversions', headers: auth(laura) });
  const record = list.json().conversions.find((r: { id: string }) => r.id === id);
  assert.equal(record.status, 'flagged');

  /*
   * INVERTED: the same six steps, from the TASK rather than a `checklist` column on the row.
   *
   * The column was a module-local to-do list — six ordered steps with `done` flags and nobody
   * assigned to work them — which CLAUDE.md forbids outright. The conversion now spawns a real
   * task carrying the steps, and migration 0069 dropped the column. The counts below are
   * unchanged on purpose: the assertion is the same, the source is different and now provable.
   */
  assert.equal(record.checklist.length, 6, 'the six conversion steps, composed from the task');
  assert.equal(record.checklist[0].done, false);
  assert.ok(record.task_id, 'the conversion points at its task, so a UI can tick items there');

  const owned = await app.db.query<{ assigned: string | null; n: number }>(
    `SELECT t.assigned_staff_id AS assigned,
            (SELECT count(*)::int FROM task_checklist_items i WHERE i.task_id = t.id) AS n
       FROM tasks t WHERE t.source_type = 'pllc_conversion' AND t.source_id = $1`,
    [id]
  );
  assert.equal(owned.rows[0]!.n, 6, 'the steps live on the task, in the unified task system');
  assert.equal(owned.rows[0]!.assigned, laura.id, 'and the work is ASSIGNED, which the column never was');

  // The old write path is refused rather than silently accepted.
  const oldWay = await app.inject({
    method: 'PATCH', url: `/pllc-conversions/${id}`, headers: auth(laura),
    payload: { checklist: [{ item: 'x', done: true }] },
  });
  assert.equal(oldWay.statusCode, 400, 'ticking on the row is refused, not quietly dropped');
  assert.match(oldWay.json().message, /lives on the task now/);

  const verified = await app.inject({
    method: 'PATCH', url: `/pllc-conversions/${id}`, headers: auth(laura),
    payload: { licenseVerified: true, status: 'advisory_scheduled' },
  });
  assert.equal(verified.statusCode, 200, verified.body);
  const row = await app.db.query(`SELECT license_verified, status FROM pllc_conversions WHERE id = $1`, [id]);
  assert.equal(row.rows[0].license_verified, true);
  assert.equal(row.rows[0].status, 'advisory_scheduled');
});
