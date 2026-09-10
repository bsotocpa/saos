// ITEM 0 (2026-09-09, Brian's ruling): DATE CONSUMERS, not renderers.
//
// The driver now returns a DATE column as 'YYYY-MM-DD' text. Every consumer that compares or
// does arithmetic on one goes through calendarDay(): a validated day compares correctly with
// < > <= >=, and a Date object, an instant or garbage throws with the value named instead of
// deciding "not overdue" silently. These tests put fixture dates on BOTH sides of today for
// each date-driven decision: overdue detection and overdue_since, late-fee assessment, the
// price lock, the tax deadline lists, the perfection clock, annual-report reminders and the
// document chase. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { withTransaction } from '../src/db.ts';
import { addDays, calendarDay, daysBetween, isCalendarDay, todayChicago } from '../src/modules/tax/deadlines.ts';
import { runInvoiceOverdueJob } from '../src/modules/billing/service.ts';
import { runDunningJob, lateFeeTerms } from '../src/modules/billing/dunning.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { pauseEngagement, resumeEngagement } from '../src/modules/engagements/pause.ts';
import { runExtensionDecisionListJob } from '../src/modules/tax/extension.ts';
import { runPerfectionClockJob } from '../src/modules/tax/pipeline.ts';
import { runEntityComplianceJob } from '../src/modules/entity/service.ts';
import { runDocumentChaseJob } from '../src/modules/documents/service.ts';

let app: FastifyInstance;
let config: Config;
let preparer: TestStaff & { token: string };
let ceoId = '';
const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const today = todayChicago();
const T = (n: number) => addDays(today, n);

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

let seq = 0;
async function client(): Promise<{ id: string; email: string }> {
  seq += 1;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: `Dates${seq}`, email: `dates-${seq}@example.test` });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  return c;
}
async function invoice(contactId: string, status: string, opts: { sentOn?: string; overdueSince?: string; total?: number }): Promise<string> {
  seq += 1;
  const { rows } = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at, overdue_since)
     VALUES ($1, $2, $3::invoice_status, $4, $4, 0, ($5::date)::timestamptz, $6::date) RETURNING id`,
    [`SYN-DATE-${String(seq).padStart(4, '0')}`, contactId, status, opts.total ?? 70000, opts.sentOn ?? today, opts.overdueSince ?? null]
  );
  return rows[0]!.id;
}
const actor = () => ({ id: ceoId, email: 'ceo-dates@example.test', fullName: 'Synthetic CEO', roleKey: 'ceo' as const, permissions: ['*'], sessionId: 'test' });

before(async () => {
  config = await createTestConfig('datecons');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  preparer = await staffWithToken('preparer-dates@example.test', 'tax_preparer');
  ceoId = (await makeStaff(app.db, config, { email: 'ceo-dates@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-1234567' })).id;
});

after(async () => {
  await app.close();
});

test('calendarDay: a validated day compares; a Date, an instant, a number or garbage throws with the value named', () => {
  assert.ok(calendarDay('2026-09-08') < calendarDay('2026-09-09'));
  assert.ok(calendarDay('2026-09-09') >= calendarDay('2026-09-09'));
  assert.ok(isCalendarDay(today));
  assert.throws(() => calendarDay(new Date('2026-09-09T00:00:00Z'), 'due_date'), /due_date is a Date object/);
  assert.throws(() => calendarDay('2026-09-09T00:00:00.000Z'), /not a calendar day/);
  assert.throws(() => calendarDay(1757376000000), /not a calendar day/);
  assert.throws(() => calendarDay(null, 'overdue_since'), /overdue_since is not a calendar day/);
  assert.throws(() => daysBetween(new Date() as unknown as string, today), /from is a Date object/);
  assert.equal(daysBetween(T(-3), today), 3);
  assert.equal(addDays(today, 1), T(1));
});

test('overdue detection: an invoice sent 15 days ago flips to overdue with overdue_since = today; one sent 13 days ago stays sent', async () => {
  const c = await client();
  const late = await invoice(c.id, 'sent', { sentOn: T(-15) });
  const fresh = await invoice(c.id, 'sent', { sentOn: T(-13) });
  const run = await runInvoiceOverdueJob(app, today);
  assert.equal(run.skipped, false);
  const rows = await app.db.query<{ id: string; status: string; overdue_since: string | null }>(
    `SELECT id, status::text AS status, overdue_since::text AS overdue_since FROM invoices WHERE id = ANY($1::uuid[])`, [[late, fresh]]);
  const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));
  assert.equal(byId[late]!.status, 'overdue');
  assert.equal(byId[late]!.overdue_since, today, 'overdue_since is today, as a calendar day');
  assert.equal(byId[fresh]!.status, 'sent');
  assert.equal(byId[fresh]!.overdue_since, null);
});

test('late fees: assessed when overdue past the grace period with a signed disclosure; not one day short; not twice inside 30 days; again after 30', async () => {
  const terms = await lateFeeTerms(app);
  const c = await client();
  await app.db.query(
    `UPDATE contacts SET late_fee_disclosure_signed_at = now(),
            late_fee_disclosed_rate_percent = (SELECT late_fee_rate_percent FROM templates WHERE key = 'engagement_master')
      WHERE id = $1`, [c.id]);
  const past = await invoice(c.id, 'overdue', { overdueSince: T(-(terms!.graceDays + 1)) });
  const short = await invoice(c.id, 'overdue', { overdueSince: T(-(terms!.graceDays - 1)) });

  const run1 = await runDunningJob(app, today);
  assert.ok(run1.feesAssessed >= 1, JSON.stringify(run1));
  const fees = async (id: string) => Number((await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM invoice_late_fees WHERE invoice_id = $1`, [id])).rows[0]!.n);
  assert.equal(await fees(past), 1, 'past the grace period: one fee');
  assert.equal(await fees(short), 0, 'one day short of the grace period: no fee');
  const assessedOn = (await app.db.query<{ d: string }>(`SELECT assessed_on::text AS d FROM invoice_late_fees WHERE invoice_id = $1`, [past])).rows[0]!.d;
  assert.equal(assessedOn, today, 'assessed_on is today, as a calendar day');

  await runDunningJob(app, T(29));
  assert.equal(await fees(past), 1, '29 days later: still one fee');
  await runDunningJob(app, T(30));
  assert.equal(await fees(past), 2, '30 days later: the second fee');
});

test('price lock: a lock that expired yesterday and one that expires tomorrow both move by the paused days, as calendar days', async () => {
  const c = await client();
  const mk = async (expires: string) => {
    const e = await createEngagement(app, actor(), { contactId: c.id, serviceLine: 'bookkeeping', title: `lock ${expires}`, status: 'active' }, {});
    await app.db.query(`UPDATE engagements SET price_lock_expires_on = $2::date WHERE id = $1`, [e.id, expires]);
    return e.id;
  };
  for (const expires of [T(-1), T(1)]) {
    const id = await mk(expires);
    await pauseEngagement(app, id, { reason: 'lock test' }, { type: 'system', label: 'test' });
    await app.db.query(`UPDATE engagements SET work_paused_at = now() - interval '6 days' WHERE id = $1`, [id]);
    const r = await resumeEngagement(app, id, { type: 'system', label: 'test' });
    assert.equal(r.pausedDays, 6);
    const after = (await app.db.query<{ d: string }>(`SELECT price_lock_expires_on::text AS d FROM engagements WHERE id = $1`, [id])).rows[0]!.d;
    assert.equal(after, addDays(expires, 6), `${expires} + 6 days`);
    assert.ok(isCalendarDay(after));
    // Bookkeeping is one-active-per-client: retire this one before the next.
    await app.db.query(`UPDATE engagements SET status = 'completed', ended_on = CURRENT_DATE WHERE id = $1`, [id]);
  }
});

test('tax deadlines: the extension decision list fires for a deadline exactly 21 days out and not for 20', async () => {
  const c = await client();
  const mk = async (deadline: string) => {
    const res = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(preparer), payload: { contactId: c.id, taxYear: 2025, returnType: '1040', clientType: 'individual' } });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().id as string;
    await app.db.query(`UPDATE tax_engagements SET original_deadline = $2::date WHERE id = $1`, [id, deadline]);
    return id;
  };
  await mk(T(21));
  await mk(T(20));
  const run = await runExtensionDecisionListJob(app, today);
  assert.equal(run.skipped, false);
  const deadlines = run.lists.map((l) => l.deadline);
  assert.ok(deadlines.includes(T(21)), `21 days out is on the list: ${deadlines.join(', ')}`);
  assert.ok(!deadlines.includes(T(20)), '20 days out is not');
  for (const d of deadlines) assert.ok(isCalendarDay(d), `the list carries calendar days: ${d}`);
});

test('perfection clock: a deadline that passed yesterday counts as overdue, one two days out warns, one ten days out does neither', async () => {
  const c = await client();
  const mk = async (deadline: string) => {
    const res = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(preparer), payload: { contactId: c.id, taxYear: 2025, returnType: '1040', clientType: 'individual' } });
    assert.equal(res.statusCode, 201, res.body);
    const id = res.json().id as string;
    await withTransaction(app.db, async () => {
      await app.db.query(`UPDATE tax_engagements SET stage = 'rejected', perfection_deadline = $3::date, preparer_id = $2 WHERE id = $1`, [id, preparer.id, deadline]);
      await app.db.query(
        `INSERT INTO tasks (title, assigned_staff_id, due_date, priority, source, source_type, source_id)
         VALUES ($1, $2, $3::date, 1, 'automation', 'efile_reject', $4)`,
        [`E-file REJECTED — fix & re-file by ${deadline}`, preparer.id, deadline, id]);
    });
    return id;
  };
  await mk(T(-1));
  await mk(T(2));
  await mk(T(10));
  const run = await runPerfectionClockJob(app, today);
  assert.equal(run.skipped, false);
  assert.ok(run.overdue >= 1, `yesterday's deadline is overdue: ${JSON.stringify(run)}`);
  assert.ok(run.warnings >= 1, `two days out warns: ${JSON.stringify(run)}`);
});

test('annual reports: due in 60 days gets the staff reminder task; due in 61 does not; past due reads overdue', async () => {
  const mk = async (name: string, due: string) => {
    const b = await app.db.query<{ id: string }>(
      `INSERT INTO businesses (name, state, formation_date, formation_date_source, formation_date_recorded_at)
       VALUES ($1, 'IL', '2020-03-01'::date, 'staff_verified', now()) RETURNING id`, [name]);
    const ec = await app.db.query<{ id: string }>(
      `INSERT INTO entity_compliance (business_id, state, annual_report_due_date, status, due_date_override_reason, due_date_override_at)
       VALUES ($1, 'IL', $2::date, 'unknown', 'synthetic fixture: due date set for the test', now()) RETURNING id`,
      [b.rows[0]!.id, due]);
    return { businessId: b.rows[0]!.id, ecId: ec.rows[0]!.id };
  };
  const at60 = await mk('Synthetic AR sixty', T(60));
  const at61 = await mk('Synthetic AR sixty-one', T(61));
  const past = await mk('Synthetic AR past', T(-1));
  const run = await runEntityComplianceJob(app, today);
  assert.equal(run.skipped, false);
  const tasksFor = async (name: string) => Number((await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM tasks WHERE source_type = 'annual_report' AND title LIKE $1`, [`%${name}%`])).rows[0]!.n);
  assert.ok((await tasksFor('Synthetic AR sixty (')) >= 1, 'T-60: a task');
  assert.equal(await tasksFor('Synthetic AR sixty-one'), 0, 'T-61: nothing yet');
  const status = async (ecId: string) => (await app.db.query<{ s: string }>(`SELECT status::text AS s FROM entity_compliance WHERE id = $1`, [ecId])).rows[0]!.s;
  assert.equal(await status(past.ecId), 'overdue');
  assert.equal(await status(at60.ecId), 'due_soon');
  assert.equal(await status(at61.ecId), 'good');
});

test('document chase: a request created past the reminder window is chased; a newer one is not; due_date is not an input to the chase (finding)', async () => {
  const c = await client();
  const days = Number((await app.db.query<{ v: string }>(`SELECT (value)::text::int AS v FROM app_settings WHERE key = 'sla.doc_request_reminder_days'`)).rows[0]?.v ?? 3);
  const mk = async (createdOn: string, due: string) => {
    const { rows } = await app.db.query<{ id: string }>(
      `INSERT INTO document_requests (contact_id, title_en, title_es, status, due_date, created_at)
       VALUES ($1, 'Synthetic bank statements', 'Estados de cuenta sintéticos', 'open', $2::date, ($3::date)::timestamptz) RETURNING id`,
      [c.id, due, createdOn]);
    return rows[0]!.id;
  };
  const old = await mk(T(-(days + 1)), T(-5));
  const fresh = await mk(T(-(days - 1)), T(-5)); // ALSO past its due date — and still not chased: the chase keys off created/last reminder
  const run = await runDocumentChaseJob(app, today);
  assert.equal(run.skipped, false);
  const count = async (id: string) => Number((await app.db.query<{ n: string }>(`SELECT reminder_count AS n FROM document_requests WHERE id = $1`, [id])).rows[0]!.n);
  assert.equal(await count(old), 1);
  assert.equal(await count(fresh), 0, 'due_date past, created recently: not chased — the chase is a timestamp rule, reported as a finding');
});
