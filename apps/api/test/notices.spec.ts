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

test('FLORIDA is uniform-deadline: May 1 for everyone, formation date does not move it', () => {
  /*
   * Fla. Stat. § 605.0212 (LLCs) / § 607.1622 (corporations). Florida is structurally different
   * from Illinois: one day a year for every entity, rather than a date derived from formation.
   *
   * THE MID-YEAR ENTITY IS THE POINT. An anniversary calculation would put a company formed on
   * 19 July on a July date, and it would look entirely plausible. Florida does not care what
   * month it was formed — the deadline is May 1 like everyone else's.
   */
  assert.equal(nextAnnualReportDueDate('FL', '2020-07-19', '2026-01-15'), '2026-05-01');
  assert.equal(nextAnnualReportDueDate('FL', '2020-11-30', '2026-01-15'), '2026-05-01');
  assert.equal(nextAnnualReportDueDate('FL', '2020-02-03', '2026-01-15'), '2026-05-01');
  assert.notEqual(
    nextAnnualReportDueDate('FL', '2020-07-19', '2026-01-15'),
    '2026-07-19',
    'the uniform deadline wins over anniversary logic'
  );

  // Strictly after `from`, same as every other state.
  assert.equal(nextAnnualReportDueDate('FL', '2020-07-19', '2026-05-01'), '2027-05-01');
  assert.equal(nextAnnualReportDueDate('FL', '2020-07-19', '2026-06-02'), '2027-05-01');

  /*
   * And the one place formation DOES matter: "The first annual report must be delivered … between
   * January 1 and May 1 of the year FOLLOWING the calendar year in which the articles became
   * effective." So an entity formed mid-2026 has nothing due in 2026 — its first report is
   * May 1, 2027, not May 1 of the year it was born.
   */
  assert.equal(nextAnnualReportDueDate('FL', '2026-07-19', '2026-01-15'), '2027-05-01');
  assert.equal(nextAnnualReportDueDate('FL', '2026-01-02', '2026-01-01'), '2027-05-01');
  // Formed in December; still nothing due until the following year.
  assert.equal(nextAnnualReportDueDate('FL', '2026-12-28', '2026-01-15'), '2027-05-01');

  // Illinois is untouched — the first-year provision is Florida's, and IL's was never researched.
  assert.equal(nextAnnualReportDueDate('IL', '2026-07-19', '2026-01-15'), '2026-07-01');
});

test('a uniform deadline derives with NO formation date; an anniversary one cannot', () => {
  /*
   * This is the shape paying for itself. All eight Florida businesses in the book have no
   * formation date recorded anywhere — and Florida does not need one: May 1 is May 1.
   *
   * Illinois does need one, because in Illinois the formation date IS the deadline. It returns
   * null rather than guessing, and the caller turns that null into work.
   */
  assert.equal(nextAnnualReportDueDate('FL', null, '2026-01-15'), '2026-05-01');
  assert.equal(nextAnnualReportDueDate('FL', null, '2026-05-01'), '2027-05-01'); // still strictly after
  assert.equal(nextAnnualReportDueDate('IL', null, '2026-01-15'), null);
  assert.equal(nextAnnualReportDueDate('WI', null, '2026-07-03'), null); // the anniversary fallback too

  /*
   * What IS lost without a formation date is only the first-year skip: an entity formed in 2026
   * would be told 2026-05-01 rather than 2027-05-01. That direction is chosen, not accidental —
   * an early report is a wasted filing, a late one is $400 Florida will not waive.
   */
  assert.equal(nextAnnualReportDueDate('FL', '2026-03-01', '2026-01-15'), '2027-05-01'); // known
  assert.equal(nextAnnualReportDueDate('FL', null, '2026-01-15'), '2026-05-01'); // unknown → the earlier one
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

/*
 * ── Brian's annual-report stop-points (2026-08-17), encoded in the routing ──
 *
 * Both were drafted as "Laura notices and stops". A stop-point only works if the person spots
 * the condition, and the system can spot both — so it does, and routes to Brian instead of
 * handing Laura a task that looks routine.
 */
async function complianceRow(opts: {
  name: string;
  state: string;
  formationDate: string;
  dueDate: string;
  overrideReason?: string;
}): Promise<string> {
  /*
   * The formation date is on the BUSINESS since 0078, with its provenance — a company has one
   * formation date whether or not anyone enrolled it in tracking. `staff_verified` because that
   * is what a fixture is: a value someone typed, with no register behind it.
   */
  const b = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, state, formation_date, formation_date_source, formation_date_recorded_at)
     VALUES ($1, $2, $3::date, 'staff_verified', now()) RETURNING id`,
    [opts.name, opts.state, opts.formationDate]
  );
  const ec = await app.db.query<{ id: string }>(
    `INSERT INTO entity_compliance
       (business_id, state, annual_report_due_date, status,
        due_date_override_reason, due_date_override_at)
     VALUES ($1, $2, $3::date, 'unknown', $4, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [b.rows[0]!.id, opts.state, opts.dueDate, opts.overrideReason ?? null]
  );
  return ec.rows[0]!.id;
}

/** Run the T-60 job for a date nobody has used, and return the task it made for `ecId`. */
async function t60TaskFor(ecId: string, runDate: string) {
  const { runEntityComplianceJob } = await import('../src/modules/entity/service.ts');
  const run = await runEntityComplianceJob(app, runDate);
  assert.equal(run.skipped, false, 'the job actually ran rather than hitting its date guard');
  const { rows } = await app.db.query<{
    title: string; description: string | null; assigned_staff_id: string | null; steps: number;
  }>(
    `SELECT t.title, t.description, t.assigned_staff_id,
            (SELECT count(*)::int FROM task_checklist_items i WHERE i.task_id = t.id) AS steps
       FROM tasks t WHERE t.source_type = 'annual_report' AND t.source_id = $1`,
    [ecId]
  );
  return rows[0];
}

test('a non-researched state does NOT go to Laura to file against a guess', async () => {
  /*
   * A state with no researched rule falls back to the formation anniversary, and that comes out
   * looking exactly as confident as a real derivation. Brian's ruling: it goes to him until the
   * rule is read from a primary source and encoded.
   *
   * INVERTED: this test used Florida, whose rule has now been researched (Fla. Stat. § 605.0212
   * / § 607.1622) and added. Colorado is the next by volume — 3 entities — and stands in for the
   * unresearched case. The Florida assertion flips rather than disappearing, because "FL is
   * researched" is now the thing worth pinning.
   */
  const { RESEARCHED_ANNUAL_REPORT_STATES } = await import('../src/modules/entity/service.ts');
  assert.ok(RESEARCHED_ANNUAL_REPORT_STATES.has('IL'), 'Illinois is researched');
  assert.ok(RESEARCHED_ANNUAL_REPORT_STATES.has('FL'), 'and Florida now is too');
  assert.ok(!RESEARCHED_ANNUAL_REPORT_STATES.has('CO'), 'Colorado is not — 3 entities waiting on it');

  // T-60 from the run date, and a due date that MATCHES the derivation so only the state escalates.
  const runDate = '2026-10-01';
  const ec = await complianceRow({
    name: 'Synthetic Colorado LLC', state: 'CO',
    formationDate: '2020-11-30', dueDate: '2026-11-30',
  });
  const task = await t60TaskFor(ec, runDate);

  assert.ok(task, 'the job created a task');
  assert.match(task.title, /NEEDS A RULING/, 'it is not presented as routine filing work');
  assert.match(task.description ?? '', /CO annual-report rules are NOT researched/);
  assert.match(task.description ?? '', /RESEARCHED_ANNUAL_REPORT_STATES/, 'and says how to make it routine');
  assert.equal(task.assigned_staff_id, brian.id, 'routed to Brian, not Laura');
  assert.equal(task.steps, 5, 'still carries the five steps');

  /*
   * Brian's standing rule, 2026-08-17: the remaining five states are NOT researched, because
   * escalating ~6 tasks a year is cheaper than reading five statutes. He asked for the escalation
   * to carry its own business case — "each one arrives with the state named and is itself the
   * business case for researching it or not" — so the task states the live count and the
   * threshold rather than making him go and count.
   */
  assert.match(task.description ?? '', /CO has 1 entity in the book/, 'the live count, counted not remembered');
  assert.match(task.description ?? '', /Below the ~5 threshold/, 'and the threshold it is measured against');
  assert.match(task.description ?? '', /annoy you/, 'plus the other trigger, which needs no counter');
});

test('the business case is COUNTED, not a number frozen in a comment', async () => {
  /*
   * The trigger is "entity count crosses ~5", so the count on the task has to be live. A frozen
   * number would keep saying "1 entity, below threshold" while the book quietly grew past it —
   * the rule would go stale with nothing reporting that it had.
   */
  for (const n of [1, 2, 3, 4]) {
    await app.db.query(`INSERT INTO businesses (name, state) VALUES ($1, 'MT')`, [`Synthetic Big Sky ${n} LLC`]);
  }
  const ec = await complianceRow({
    name: 'Synthetic Montana LLC', state: 'MT', // 5th MT business — at the threshold
    formationDate: '2020-12-01', dueDate: '2026-12-01', // T-60 of the run date below
  });
  const task = await t60TaskFor(ec, '2026-10-02');
  assert.match(task?.description ?? '', /MT has 5 entities in the book/, 'counted at run time');
  assert.match(task?.description ?? '', /at or past the ~5 threshold — worth researching now/,
    'and the verdict flips when the count crosses');
});

test('a Florida entity now routes to Laura as routine work', async () => {
  /*
   * The other half of adding a state: it stops escalating. Formed mid-year, due the uniform
   * May 1 — a combination that would have been an unexplained mismatch before the rule existed,
   * because the anniversary fallback would have derived a July date.
   */
  const runDate = '2027-03-02'; // T-60 → 2027-05-01
  const ec = await complianceRow({
    name: 'Synthetic Florida LLC', state: 'FL',
    formationDate: '2020-07-19', dueDate: '2027-05-01',
  });
  const task = await t60TaskFor(ec, runDate);

  assert.ok(task, 'the job created a task');
  assert.doesNotMatch(task.title, /NEEDS A RULING/, 'Florida is researched, so this is routine');
  assert.match(task.title, /^File annual report/);
  assert.notEqual(task.assigned_staff_id, brian.id, 'it is Laura’s work now, not an escalation');
});

test('a stored due date that disagrees with the rule goes to Brian with BOTH dates', async () => {
  /*
   * An admin override and a wrong date look identical in advance, so Laura never picks between
   * them. The task carries both so the ruling can be made without re-deriving anything.
   */
  // The job loads rows due EXACTLY at runDate + 60, so the run date is derived from the fixture:
  // 2026-12-15 minus 60 days. IL rule puts the real date at the first of the anniversary month.
  const runDate = '2026-10-16';
  const ec = await complianceRow({
    name: 'Synthetic Mismatch LLC', state: 'IL',
    formationDate: '2019-12-04', dueDate: '2026-12-15',
  });
  const task = await t60TaskFor(ec, runDate);

  assert.ok(task, 'the job created a task');
  assert.match(task.title, /NEEDS A RULING/);
  assert.match(task.description ?? '', /stored due date \(2026-12-15\)/, 'the stored date');
  assert.match(task.description ?? '', /derived date \(2026-12-01\)/, 'and the derived one');
  assert.match(task.description ?? '', /record the reason/, 'and says to record the ruling');
  assert.equal(task.assigned_staff_id, brian.id, 'Laura never picks between them');
});

test('a RECORDED override reason makes the same disagreement routine', async () => {
  /*
   * The point of recording it: "so the next disagreement isn't identical again." Same mismatch,
   * same dates — but explained, so it goes to Laura as ordinary filing work.
   */
  const runDate = '2026-10-17';
  const ec = await complianceRow({
    name: 'Synthetic Explained LLC', state: 'IL',
    formationDate: '2019-12-04', dueDate: '2026-12-16',
    overrideReason: 'IL assigned this entity a mid-month date on reinstatement (confirmed on ILSOS 2026-08-17).',
  });
  const task = await t60TaskFor(ec, runDate);

  assert.ok(task, 'the job created a task');
  assert.doesNotMatch(task.title, /NEEDS A RULING/, 'explained, so not escalated');
  assert.match(task.title, /^File annual report/, 'ordinary filing work');
  assert.notEqual(task.assigned_staff_id, brian.id, 'and it is Laura\u2019s, not Brian\u2019s');
});

test('enrolling with no formation date: Florida still gets a date, Illinois gets a task', async () => {
  /*
   * A compliance row with a null due date is INVISIBLE, not pending — the status sweep skips it
   * and both reminder loops load by exact due date. It sits in the list looking enrolled and
   * nothing ever fires. Found while production-verifying Florida: 8 FL businesses in the book,
   * not one with a formation date, and every one of them would have enrolled into silence.
   */
  const fl = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, state) VALUES ('Synthetic Sunshine LLC', 'FL') RETURNING id`
  );
  const flId = fl.rows[0]!.id;
  const flCreated = await app.inject({
    method: 'POST', url: '/entity-compliance', headers: auth(laura),
    payload: { businessId: flId },   // no formationDate, no override
  });
  assert.equal(flCreated.statusCode, 201, flCreated.body);
  assert.equal(flCreated.json().annualReportDueDate?.slice(5), '05-01', 'Florida derives anyway');
  const flSetup = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'annual_report_setup' AND source_id = $1`,
    [flCreated.json().id]
  );
  assert.equal(flSetup.rows[0]!.n, 0, 'nothing to chase — Florida needed no formation date');

  // Illinois cannot derive, so the gap becomes owned work rather than a blank row.
  const il = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, state) VALUES ('Synthetic Undated LLC', 'IL') RETURNING id`
  );
  const ilCreated = await app.inject({
    method: 'POST', url: '/entity-compliance', headers: auth(laura),
    payload: { businessId: il.rows[0]!.id },
  });
  assert.equal(ilCreated.statusCode, 201, ilCreated.body);
  assert.equal(ilCreated.json().annualReportDueDate, null);
  /*
   * INVERTED 2026-09-06 (Brian's ruling 3). Illinois used to raise its own `annual_report_setup`
   * errand for the missing formation date. It now rides the ILSOS VERIFICATION task instead —
   * whoever checks the standing is looking at the formation date on the same screen, so a second
   * task would be sending someone back to a page they already had open. Keyed on the BUSINESS,
   * because that task is about the entity rather than about one compliance row.
   */
  const ilSetup = await app.db.query<{ title: string; assigned_staff_id: string | null; sop_link: string | null }>(
    `SELECT title, assigned_staff_id, sop_link FROM tasks
      WHERE source_type = 'sos_verify' AND source_id = $1`,
    [il.rows[0]!.id]
  );
  const setupTask = ilSetup.rows[0];
  assert.ok(setupTask, 'the missing date is work, and work is a task');
  assert.match(setupTask.title, /Verify good standing on ILSOS — Synthetic Undated LLC/);
  assert.equal(setupTask.sop_link, '/sops/laura-sos-verify', 'and the manual procedure is attached');
  assert.ok(setupTask.assigned_staff_id, 'and an unassigned task is work that does not exist');
  assert.ok(setupTask.sop_link, 'with the procedure attached, like every other generated task');
});

test('the Florida cross-check works without a formation date', async () => {
  /*
   * The T-60 "stored date disagrees with the rule" ruling used to be skipped entirely when the
   * formation date was missing — `derived` was hard-coded to null before the derivation was even
   * asked. For Florida that threw away a check it could have made: a stored 2027-03-15 on a FL
   * row is wrong whether or not we know when the company was formed.
   */
  const b = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, state) VALUES ('Synthetic Keys LLC', 'FL') RETURNING id`
  );
  const ec = await app.db.query<{ id: string }>(
    `INSERT INTO entity_compliance (business_id, state, annual_report_due_date, status)
     VALUES ($1, 'FL', '2027-03-15'::date, 'unknown') RETURNING id`,
    [b.rows[0]!.id]
  );
  const task = await t60TaskFor(ec.rows[0]!.id, '2027-01-14'); // T-60 before 2027-03-15
  assert.ok(task, 'the T-60 task was created');
  assert.match(task.title, /NEEDS A RULING/);
  assert.equal(task.assigned_staff_id, brian.id, 'a disagreement Laura must not settle');
  assert.match(task.description ?? '', /2027-05-01/, 'and Brian gets both dates');
});

test('the override columns must be recorded together', async () => {
  // A reason with no date is a half-recorded decision — the thing the column exists to prevent.
  const b = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, state) VALUES ('Synthetic Halfrecorded LLC', 'IL') RETURNING id`
  );
  await assert.rejects(
    () =>
      app.db.query(
        `INSERT INTO entity_compliance (business_id, state, annual_report_due_date, status, due_date_override_reason)
         VALUES ($1, 'IL', CURRENT_DATE + 60, 'unknown', 'a reason with no date')`,
        [b.rows[0]!.id]
      ),
    /entity_compliance_override_is_complete/
  );
});

test('a formation date cannot be stored without saying where it came from', async () => {
  /*
   * This date derives a STATUTORY deadline — in Illinois the formation date IS the annual-report
   * due date. A date somebody half-remembered on a call and a date read off the state's register
   * produce identical rows and identical deadlines, which is the same indistinguishability that
   * `due_date_override_reason` and RESEARCHED_ANNUAL_REPORT_STATES exist to break.
   *
   * So the database refuses a date with no provenance, rather than the route being trusted to
   * remember. Same shape as `entity_compliance_override_is_complete` (0072).
   */
  await assert.rejects(
    () =>
      app.db.query(
        `INSERT INTO businesses (name, state, formation_date) VALUES ('Synthetic Unsourced LLC', 'IL', '2020-03-04')`
      ),
    /businesses_formation_date_is_sourced/,
    'a date with no source is refused'
  );

  await assert.rejects(
    () =>
      app.db.query(
        `INSERT INTO businesses (name, state, formation_date, formation_date_source, formation_date_recorded_at)
         VALUES ('Synthetic Vibes LLC', 'IL', '2020-03-04', 'someone_said_so', now())`
      ),
    /businesses_formation_date_source_known/,
    'and an invented source is refused too — the vocabulary is fixed'
  );

  // The four real sources, weakest to strongest, all accepted.
  for (const source of ['client_stated', 'staff_verified', 'sos_document', 'sos_register']) {
    const ok = await app.db.query<{ id: string }>(
      `INSERT INTO businesses (name, state, formation_date, formation_date_source, formation_date_recorded_at)
       VALUES ($1, 'IL', '2020-03-04', $2, now()) RETURNING id`,
      [`Synthetic Sourced ${source} LLC`, source]
    );
    assert.ok(ok.rows[0]?.id, `${source} is a real source`);
  }

  /*
   * `client_stated` is ALLOWED on purpose. Banning the weakest source would not produce better
   * data — it would leave the column null and the entity untracked, and a tracked entity whose
   * date is labelled unverified beats an untracked one.
   */
});

test('enrolment records the formation date on the BUSINESS, and does not claim the register', async () => {
  const biz = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, state) VALUES ('Synthetic Provenance LLC', 'IL') RETURNING id`
  );
  const created = await app.inject({
    method: 'POST', url: '/entity-compliance', headers: auth(laura),
    payload: { businessId: biz.rows[0]!.id, formationDate: '2021-06-15' },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().annualReportDueDate?.slice(5), '06-01', 'and the IL rule derived from it');

  const after = await app.db.query<{ d: string; source: string; at: string | null }>(
    `SELECT formation_date::text AS d, formation_date_source AS source, formation_date_recorded_at::text AS at
       FROM businesses WHERE id = $1`,
    [biz.rows[0]!.id]
  );
  assert.equal(after.rows[0]?.d, '2021-06-15', 'the date landed on the business, not the compliance row');
  assert.equal(after.rows[0]?.source, 'staff_verified',
    'a date typed into a form is staff_verified — claiming sos_register for it would be the provenance lie the stamp exists to prevent');
  assert.ok(after.rows[0]?.at, 'and stamped when');

  /*
   * A second enrolment does NOT overwrite it. Whatever is on the business was recorded with a
   * source; an enrolment form has no way to know its own value is better, and silently replacing
   * a register-sourced date with a typed one would downgrade the provenance invisibly.
   */
  await app.db.query(
    `UPDATE businesses SET formation_date = '2019-01-02', formation_date_source = 'sos_register',
            formation_date_recorded_at = now() WHERE id = $1`,
    [biz.rows[0]!.id]
  );
  const biz2 = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, state, formation_date, formation_date_source, formation_date_recorded_at)
     VALUES ('Synthetic Registered LLC', 'IL', '2019-01-02', 'sos_register', now()) RETURNING id`
  );
  const second = await app.inject({
    method: 'POST', url: '/entity-compliance', headers: auth(laura),
    payload: { businessId: biz2.rows[0]!.id, formationDate: '2023-11-30' },
  });
  assert.equal(second.statusCode, 201, second.body);
  const kept = await app.db.query<{ d: string; source: string }>(
    `SELECT formation_date::text AS d, formation_date_source AS source FROM businesses WHERE id = $1`,
    [biz2.rows[0]!.id]
  );
  assert.equal(kept.rows[0]?.d, '2019-01-02', 'the register-sourced date survived');
  assert.equal(kept.rows[0]?.source, 'sos_register');
  assert.equal(second.json().annualReportDueDate?.slice(5), '01-01',
    'and the deadline derived from the date we kept, not the one that was posted');
});

/** A business + primary contact at a given lifecycle status, for the (3b) enrolment tests. */
async function scopedBusiness(opts: {
  name: string; slug: string; state: string; entityType: string | null; status: string; formationDate?: string;
}): Promise<{ businessId: string; contactId: string }> {
  const c = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, contact_status)
     VALUES ('Synthetic', $1, $2, $3::contact_lifecycle) RETURNING id`,
    [opts.slug, `${opts.slug.toLowerCase()}@example.test`, opts.status]
  );
  const b = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, state, entity_type, formation_date, formation_date_source, formation_date_recorded_at)
     VALUES ($1, $2, $3::business_entity_type, $4::date,
             CASE WHEN $4::text IS NULL THEN NULL ELSE 'staff_verified' END,
             CASE WHEN $4::text IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [opts.name, opts.state, opts.entityType, opts.formationDate ?? null]
  );
  await app.db.query(
    `INSERT INTO business_members (business_id, contact_id, member_role, is_primary) VALUES ($1, $2, 'owner', true)`,
    [b.rows[0]!.id, c.rows[0]!.id]
  );
  return { businessId: b.rows[0]!.id, contactId: c.rows[0]!.id };
}

test('(3b) one door: the scope rule is enforced in the enrolment function, not at each caller', async () => {
  const { enrolEntityIfInScope } = await import('../src/modules/entity/enrolment.ts');

  // In scope: dormant client, an LLC that owes a report, IL with a formation date.
  const good = await scopedBusiness({
    name: 'Synthetic Enrolme LLC', slug: 'Enrolme', state: 'IL', entityType: 'llc',
    status: 'dormant', formationDate: '2021-04-09',
  });
  const ok = await enrolEntityIfInScope(app, good.businessId, 'formation_completed');
  assert.equal(ok.enrolled, true, 'an in-scope entity enrols');
  assert.ok(
    ok.enrolled && ok.dueDate?.endsWith('-04-01'),
    `IL derives the anniversary month (got ${ok.enrolled ? ok.dueDate : 'not enrolled'})`
  );

  // Idempotent — a second trigger does not create a second compliance row.
  const again = await enrolEntityIfInScope(app, good.businessId, 'annual_report_engaged');
  assert.equal(again.enrolled, false);
  assert.equal(again.enrolled === false && again.reason, 'already_enrolled');

  /*
   * Each way it can decline is its own reason, and the three are NOT interchangeable:
   * "owes nothing" is a decision, "unknown" is a question, "out of scope" is about the client.
   */
  const lead = await scopedBusiness({
    name: 'Synthetic Leadco LLC', slug: 'Leadco', state: 'IL', entityType: 'llc', status: 'lead',
  });
  const l = await enrolEntityIfInScope(app, lead.businessId, 'formation_completed');
  assert.equal(l.enrolled === false && l.reason, 'client_out_of_scope', 'a lead is not ours to file for');

  const sole = await scopedBusiness({
    name: 'Synthetic Soleprop Co', slug: 'Soleprop', state: 'IL', entityType: 'sole_prop', status: 'active',
  });
  const s = await enrolEntityIfInScope(app, sole.businessId, 'formation_completed');
  assert.equal(s.enrolled === false && s.reason, 'type_owes_nothing', 'a sole prop registers nothing');

  const unknown = await scopedBusiness({
    name: 'Synthetic Untyped Co', slug: 'Untyped', state: 'IL', entityType: null, status: 'active',
  });
  const u = await enrolEntityIfInScope(app, unknown.businessId, 'formation_completed');
  assert.equal(u.enrolled === false && u.reason, 'type_unknown', 'and an unknown type is a question, not a no');

  // None of the three declines created a compliance row.
  const rows = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM entity_compliance WHERE business_id = ANY($1::uuid[])`,
    [[lead.businessId, sole.businessId, unknown.businessId]]
  );
  assert.equal(rows.rows[0]!.n, 0, 'declining enrols nothing');
});

test('(3b) an auto-enrolment with no derivable date is not quieter than a manual one', async () => {
  /*
   * IL with no formation date derives nothing, and a compliance row with a null due date is
   * invisible rather than pending. The staff route raises a task for exactly this; an automatic
   * enrolment is MORE likely to go unnoticed, because nobody was watching when it happened.
   */
  const { enrolEntityIfInScope } = await import('../src/modules/entity/enrolment.ts');
  const biz = await scopedBusiness({
    name: 'Synthetic Datefree LLC', slug: 'Datefree', state: 'IL', entityType: 'llc', status: 'active',
  });
  const res = await enrolEntityIfInScope(app, biz.businessId, 'annual_report_engaged');
  assert.equal(res.enrolled, true);
  assert.equal(res.enrolled && res.dueDate, null, 'IL cannot derive without a formation date');

  /*
   * INVERTED 2026-09-06 (Brian's ruling 3). An Illinois auto-enrolment with no formation date now
   * raises the ILSOS VERIFICATION task rather than its own errand — one trip to the state's site,
   * not two. The rule under test is unchanged and is still the point: an automatic enrolment that
   * derives nothing must not be QUIETER than a manual one, because nobody was watching when it
   * happened. Only which task carries it moved.
   */
  const task = await app.db.query<{ title: string; assigned_staff_id: string | null; description: string | null }>(
    `SELECT title, assigned_staff_id, description FROM tasks
      WHERE source_type = 'sos_verify' AND source_id = $1`,
    [biz.businessId]
  );
  assert.ok(task.rows[0], 'the silent row became owned work');
  assert.match(task.rows[0]!.title, /Verify good standing on ILSOS — Synthetic Datefree LLC/);
  assert.ok(task.rows[0]!.assigned_staff_id, 'assigned to a real person');
  assert.match(
    task.rows[0]!.description ?? '',
    /no formation date on record/,
    'and it asks for the date too, so one visit answers both'
  );

  // Florida needs no formation date, so the same situation enrols cleanly and raises nothing.
  const fl = await scopedBusiness({
    name: 'Synthetic Datefree FL LLC', slug: 'DatefreeFL', state: 'FL', entityType: 'llc', status: 'active',
  });
  const flRes = await enrolEntityIfInScope(app, fl.businessId, 'annual_report_engaged');
  assert.ok(flRes.enrolled && flRes.dueDate?.endsWith('-05-01'), 'uniform deadline, no date needed');
  const flTask = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'annual_report_setup' AND source_id = $1`,
    [flRes.enrolled ? flRes.complianceId : '00000000-0000-0000-0000-000000000000']
  );
  assert.equal(flTask.rows[0]!.n, 0, 'nothing to chase');
});

test('(3b) the trigger is the SCOPE ITEM, not the service line', async () => {
  /*
   * `entity` also covers BOI reports, DBAs, amendments and S-corp conversions. Keying enrolment
   * on the service line would put an annual-report deadline on a client who asked us to file one
   * BOI report — so the scope snapshot (#47) is what decides.
   */
  const { enrolFromEngagement } = await import('../src/modules/entity/enrolment.ts');
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  const versionId = version.rows[0]!.id;

  const withScope = async (
    who: { businessId: string; contactId: string },
    itemCode: string
  ): Promise<string> => {
    const e = await app.db.query<{ id: string }>(
      `INSERT INTO engagements (contact_id, business_id, service_line, status)
       VALUES ($1, $2, 'entity', 'active') RETURNING id`,
      [who.contactId, who.businessId]
    );
    await app.db.query(
      `INSERT INTO engagement_scope_items
         (engagement_id, price_book_version_id, item_code, description_en, quantity, unit_cents, line_cents)
       VALUES ($1, $2, $3, $3, 1, 0, 0)`,
      [e.rows[0]!.id, versionId, itemCode]
    );
    return e.rows[0]!.id;
  };

  const boiOnly = await scopedBusiness({
    name: 'Synthetic Boionly LLC', slug: 'Boionly', state: 'FL', entityType: 'llc', status: 'active',
  });
  const boi = await withScope(boiOnly, 'ENTITY_BOI');
  assert.equal(
    await enrolFromEngagement(app, boi, 'annual_report_engaged'),
    null,
    'a BOI engagement enrols nothing — the service line alone would have enrolled it'
  );

  const annualClient = await scopedBusiness({
    name: 'Synthetic Annualco LLC', slug: 'Annualco', state: 'FL', entityType: 'llc', status: 'active',
  });
  const annual = await withScope(annualClient, 'ENTITY_ANNUAL_REPORT');
  const res = await enrolFromEngagement(app, annual, 'annual_report_engaged');
  assert.equal(res?.enrolled, true, 'an annual-report engagement does');

  // And the formation trigger looks at a different code again.
  const formed = await scopedBusiness({
    name: 'Synthetic Formed LLC', slug: 'Formedco', state: 'FL', entityType: 'llc', status: 'active',
  });
  const formation = await withScope(formed, 'ENTITY_FORMATION_EIN');
  assert.equal(
    await enrolFromEngagement(app, formation, 'annual_report_engaged'),
    null,
    'a formation engagement is not an annual-report engagement'
  );
  assert.equal(
    (await enrolFromEngagement(app, formation, 'formation_completed'))?.enrolled,
    true,
    'but it enrols when the formation completes'
  );
});
