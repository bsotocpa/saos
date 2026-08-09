// M8 "Prove it": table-driven deadline derivation (incl. fiscal-year offsets
// — proving there is no hardcoded date swap), clock-injected T-21 decision
// list job around the Mar 15 / Apr 15 boundaries, summer chase with
// escalating copy + at-risk alerts, deadline dashboard. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { extendedDeadline, nextAg990Deadline, originalDeadline, addDays, daysBetween } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff & { token: string };
let preparer: TestStaff & { token: string };

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

async function makeTaxEngagement(
  contactId: string,
  returnType: string,
  taxYear: number,
  opts: { businessId?: string } = {}
): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(preparer),
    payload: {
      contactId, taxYear, returnType, preparerId: preparer.id,
      ...(opts.businessId ? { businessId: opts.businessId } : {}),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

before(async () => {
  config = await createTestConfig('ext');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  ceo = await staffWithToken('ceo-ext@example.test', 'ceo');
  preparer = await staffWithToken('preparer-ext@example.test', 'tax_preparer');
});

after(async () => {
  await app.close();
});

test('deadline derivation: table-driven, calendar AND fiscal year (no hardcoded swap)', () => {
  const cases: Array<[string, number, number, string | null, string | null]> = [
    // [returnType, taxYear, fyeMonth, original, extended] — v4.3 authoritative
    // table, BUSINESS-DAY ROLLED (2026-03-15 + 2026-11-15 + 2027-08-15 are
    // Sundays; 2027-02-15 is Washington's Birthday).
    ['1040', 2025, 12, '2026-04-15', '2026-10-15'],
    ['1065', 2025, 12, '2026-03-16', '2026-09-15'],
    ['1120s', 2025, 12, '2026-03-16', '2026-09-15'],
    ['1120', 2025, 12, '2026-04-15', '2026-10-15'],
    ['990', 2025, 12, '2026-05-15', '2026-11-16'],
    ['990ez', 2025, 12, '2026-05-15', '2026-11-16'],
    // v4.3 new rows (calendar year):
    ['1041', 2025, 12, '2026-04-15', '2026-09-30'],          // estate/trust — Sep 30, NOT +6
    ['1120f', 2025, 12, '2026-04-15', '2026-10-15'],         // foreign corp WITH US office
    ['1120f_foreign', 2025, 12, '2026-06-15', '2026-12-15'], // no US office
    ['1040_expat', 2025, 12, '2026-06-15', '2026-10-15'],    // Jun 15 automatic → Oct 15
    ['fbar', 2025, 12, '2026-04-15', '2026-10-15'],          // extension automatic
    // Fiscal-year filers: original = 15th of Nth month after FYE; extended = +6mo.
    ['1120', 2026, 6, '2026-10-15', '2027-04-15'],
    ['990', 2026, 9, '2027-02-16', '2027-08-16'],            // 990 = month 5 after FYE
    ['1065', 2026, 3, '2026-06-15', '2026-12-15'],
    ['1120s', 2026, 11, '2027-02-16', '2027-08-16'],
    // v4.5: AG990-IL — end of FYE+6 (NOT the 15th), 60-day AG extension.
    ['ag990il', 2025, 12, '2026-06-30', '2026-08-31'],       // +60d = Aug 29 Sat → Mon
    // W-7 has no standalone deadline.
    ['w7_itin', 2025, 12, null, null],
  ];
  for (const [rt, year, fye, orig, ext] of cases) {
    assert.equal(originalDeadline(rt as never, year, fye), orig, `${rt}/${year}/fye${fye} original`);
    assert.equal(extendedDeadline(rt as never, year, fye), ext, `${rt}/${year}/fye${fye} extended`);
  }
  // The famous compound roll: Apr 15 2028 is a Saturday, DC Emancipation Day
  // (Apr 16) falls Sunday and is observed Monday Apr 17 — so the real filing
  // deadline is TUESDAY APR 18, matching the IRS calendar.
  assert.equal(originalDeadline('1040', 2027, 12), '2028-04-18');
  // Date helpers.
  assert.equal(addDays('2026-03-15', -21), '2026-02-22');
  assert.equal(daysBetween('2026-08-20', '2026-09-15'), 26);
});

test('T-21 decision list job fires per deadline, once per day, and the list is queryable', async () => {
  const clientA = await makeClient('Partnership', 'partnership-ext@example.test');
  const engA = await makeTaxEngagement(clientA, '1065', 2025); // deadline 2026-03-16 (Mar 15 = Sunday)
  const clientB = await makeClient('Individual', 'individual-ext@example.test');
  await makeTaxEngagement(clientB, '1040', 2025); // deadline 2026-04-15

  // T-21 before the ROLLED Mar 16 → only the 1065 fires.
  const run1 = await app.inject({
    method: 'POST', url: '/jobs/extension-decision-list?asOf=2026-02-23', headers: auth(ceo),
  });
  assert.equal(run1.statusCode, 200, run1.body);
  assert.equal(run1.json().skipped, false);
  assert.deepEqual(run1.json().lists, [{ deadline: '2026-03-16', count: 1 }]);

  // Same day again → idempotent skip (safe across restarts).
  const rerun = await app.inject({
    method: 'POST', url: '/jobs/extension-decision-list?asOf=2026-02-23', headers: auth(ceo),
  });
  assert.equal(rerun.json().skipped, true);

  // Notifications reached CEO + preparer roles.
  const notes = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'extension_decision_list'`
  );
  assert.ok(notes.rows[0].n >= 2, 'decision-list notifications for ceo + tax_preparer');

  // The list endpoint returns the 1065, sorted by preparer.
  const list = await app.inject({
    method: 'GET', url: '/tax-engagements/extension-decision-list?deadline=2026-03-16', headers: auth(preparer),
  });
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().engagements.length, 1);
  assert.equal(list.json().engagements[0].id, engA);

  // T-21 before Apr 15 → the 1040 fires.
  const run2 = await app.inject({
    method: 'POST', url: '/jobs/extension-decision-list?asOf=2026-03-25', headers: auth(ceo),
  });
  assert.deepEqual(run2.json().lists, [{ deadline: '2026-04-15', count: 1 }]);
});

test('Extend decision → bilingual client notice; payment estimate flow; filed → DERIVED deadline', async () => {
  const client = await makeClient('Extendida', 'extendida@example.test', 'es');
  const eng = await makeTaxEngagement(client, '1065', 2025);

  // Mark Extend → Spanish notice (extension of time to FILE, not to PAY).
  const decision = await app.inject({
    method: 'POST', url: `/tax-engagements/${eng}/extension/decision`, headers: auth(preparer),
    payload: { recommend: true },
  });
  assert.equal(decision.statusCode, 200, decision.body);
  const notice = sentMail.find((m) => m.to === 'extendida@example.test');
  assert.ok(notice, 'extension notice sent');
  assert.match(notice.subject, /extensión/i);
  assert.match(notice.text, /PRESENTAR, no para PAGAR/);
  assert.match(notice.text, /2026-09-15/);

  // Payment estimate → reminder with the formatted amount.
  const estimate = await app.inject({
    method: 'POST', url: `/tax-engagements/${eng}/extension/payment-estimate`, headers: auth(preparer),
    payload: { amountCents: 125000 },
  });
  assert.equal(estimate.statusCode, 200, estimate.body);
  const payMail = [...sentMail].reverse().find((m) => m.to === 'extendida@example.test');
  assert.match(payMail!.text, /\$1,250\.00/);

  const made = await app.inject({
    method: 'POST', url: `/tax-engagements/${eng}/extension/payment-made`, headers: auth(preparer),
    payload: { made: true },
  });
  assert.equal(made.statusCode, 200);

  // Filed → Extended tag + deadline swap by derivation.
  const filed = await app.inject({
    method: 'POST', url: `/tax-engagements/${eng}/extension/filed`, headers: auth(preparer),
  });
  assert.equal(filed.statusCode, 200, filed.body);
  assert.equal(filed.json().extendedDeadline, '2026-09-15');

  const row = await app.db.query(
    `SELECT extension_filed, extension_payment_made, extended_deadline::text AS ext FROM tax_engagements WHERE id = $1`,
    [eng]
  );
  assert.equal(row.rows[0].extension_filed, true);
  assert.equal(row.rows[0].extension_payment_made, true);
  assert.equal(row.rows[0].ext, '2026-09-15');
});

test('fiscal-year filer gets a derived extended deadline no swap could produce', async () => {
  const client = await makeClient('Fiscalyear', 'fiscal-ext@example.test');
  const biz = await app.db.query<{ id: string }>(
    `INSERT INTO businesses (name, entity_type, fiscal_year_end_month) VALUES ('Synthetic FY Corp', 'c_corp', 6) RETURNING id`
  );
  await app.db.query(
    `INSERT INTO business_members (business_id, contact_id, member_role, is_primary) VALUES ($1, $2, 'owner', true)`,
    [biz.rows[0]!.id, client]
  );
  const eng = await makeTaxEngagement(client, '1120', 2026, { businessId: biz.rows[0]!.id });

  const filed = await app.inject({
    method: 'POST', url: `/tax-engagements/${eng}/extension/filed`, headers: auth(preparer),
  });
  assert.equal(filed.statusCode, 200, filed.body);
  // FYE June 2026 → original 2026-10-15 → extended 2027-04-15. Not Sep/Oct/Nov 15.
  assert.equal(filed.json().extendedDeadline, '2027-04-15');
});

test('summer chase: escalating copy, skips clients whose docs are in, flags at-risk in August', async () => {
  // Chase target: extended, no docs, preparer assigned.
  const chaseMe = await makeClient('Chaseme', 'chase-me@example.test');
  const engChase = await makeTaxEngagement(chaseMe, '1040', 2025);
  await app.inject({
    method: 'POST', url: `/tax-engagements/${engChase}/extension/filed`, headers: auth(preparer),
  });

  // Docs already received: no chase.
  const done = await makeClient('Docsin', 'docs-in@example.test');
  const engDone = await makeTaxEngagement(done, '1040', 2025);
  await app.inject({
    method: 'POST', url: `/tax-engagements/${engDone}/extension/filed`, headers: auth(preparer),
  });
  await app.db.query(`UPDATE tax_engagements SET docs_received_at = now() WHERE id = $1`, [engDone]);

  // June 1 → gentle chase.
  const june = await app.inject({ method: 'POST', url: '/jobs/summer-chase?asOf=2026-06-01', headers: auth(ceo) });
  assert.equal(june.statusCode, 200, june.body);
  assert.equal(june.json().skipped, false);
  const juneMail = sentMail.filter((m) => m.to === 'chase-me@example.test');
  assert.ok(juneMail.some((m) => /fall rush/i.test(m.subject)), 'June copy is the gentle one');
  assert.ok(!sentMail.some((m) => m.to === 'docs-in@example.test'), 'docs-received client is not chased');

  // Same date re-run → skipped. Non-chase date → skipped.
  assert.equal(
    (await app.inject({ method: 'POST', url: '/jobs/summer-chase?asOf=2026-06-01', headers: auth(ceo) })).json().skipped,
    true
  );
  assert.equal(
    (await app.inject({ method: 'POST', url: '/jobs/summer-chase?asOf=2026-06-02', headers: auth(ceo) })).json().skipped,
    true
  );

  // Aug 15 → urgent copy + at-risk alert to the preparer.
  const august = await app.inject({ method: 'POST', url: '/jobs/summer-chase?asOf=2026-08-15', headers: auth(ceo) });
  assert.equal(august.json().skipped, false);
  assert.ok(august.json().atRiskAlerts >= 1, 'August run raises at-risk alerts');
  const augustMail = sentMail.filter((m) => m.to === 'chase-me@example.test');
  assert.ok(augustMail.some((m) => /action needed/i.test(m.subject)), 'August copy is the urgent one');
  const alert = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'extension_at_risk' AND staff_id = $1`,
    [preparer.id]
  );
  assert.ok(alert.rows[0].n >= 1);
});

test('deadline dashboard: countdowns, extended + at-risk counts', async () => {
  const res = await app.inject({
    method: 'GET', url: '/dashboards/deadlines?asOf=2026-08-20', headers: auth(preparer),
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.ok(body.extendedCount >= 2, 'extended engagements counted');
  assert.ok(body.atRiskCount >= 1, 'extended + no docs past Aug 15 = at risk');
  const chase = body.engagements.find((e: { client: string }) => e.client === 'Synthetic Chaseme');
  assert.ok(chase, 'chase client on the board');
  assert.equal(chase.deadline, '2026-10-15');
  assert.equal(chase.daysLeft, daysBetween('2026-08-20', '2026-10-15'));
  assert.equal(chase.atRisk, true);
  assert.ok(body.byDeadline['2026-10-15'].total >= 1);

  // v4.3: the staff board ALWAYS shows the next estimated-payment dates.
  assert.equal(body.estimates.length, 4);
  assert.equal(body.estimates[0].date, '2026-09-15'); // Q3 (Tue — no roll)
  assert.equal(body.estimates[1].date, '2027-01-15'); // Q4 of TY2026 (Fri)
  assert.ok(body.estimates[0].quarter.startsWith('Q3'));
});

// ── M24 (v4.3 addendum) ──────────────────────────────────────────────────────

test('AG990-IL (v4.5): state charity clock — FYE+6 month-end, 60-day AG extensions, independent of the 990', async () => {
  // Fiscal-year charity (FYE Jun): due Dec 31; +60 days = Mar 1.
  assert.equal(originalDeadline('ag990il', 2026, 6), '2026-12-31');
  assert.equal(extendedDeadline('ag990il', 2026, 6), '2027-03-01');
  // Second (final) AG extension = +120 days; requests clamp at two.
  assert.equal(extendedDeadline('ag990il', 2025, 12, 2), '2026-10-28');
  assert.equal(extendedDeadline('ag990il', 2025, 12, 9), '2026-10-28');
  // INDEPENDENT clocks: the federal 990's Nov 15 extension never moves this.
  assert.notEqual(extendedDeadline('ag990il', 2025, 12), extendedDeadline('990', 2025, 12));
  // Per-client next-occurrence helper (what the dashboard derives from FYE).
  assert.deepEqual(nextAg990Deadline('2026-07-12', 12), { fiscalYear: 2026, date: '2027-06-30' });
  assert.deepEqual(nextAg990Deadline('2026-05-01', 12), { fiscalYear: 2025, date: '2026-06-30' });

  // Deadline dashboard: every IL-registered charity gets its own AG990-IL row.
  await app.db.query(
    `INSERT INTO businesses (name, entity_type, state, fiscal_year_end_month)
     VALUES ('Synthetic Charity Org', 'nonprofit', 'IL', 12)`
  );
  const res = await app.inject({
    method: 'GET', url: '/dashboards/deadlines?asOf=2026-08-20', headers: auth(preparer),
  });
  assert.equal(res.statusCode, 200, res.body);
  const row = res.json().ag990.find((r: { business: string }) => r.business === 'Synthetic Charity Org');
  assert.ok(row, 'IL charity tracked on the board');
  assert.equal(row.deadline, '2027-06-30');
  assert.equal(row.daysLeft, daysBetween('2026-08-20', '2027-06-30'));
});

test('FBAR: automatic extension keeps it OFF the T-21 decision list', async () => {
  const fb = await makeClient('Fbar', 'fbar-client@example.test');
  await makeTaxEngagement(fb, 'fbar', 2026); // original 2027-04-15
  const run = await app.inject({
    method: 'POST', url: '/jobs/extension-decision-list?asOf=2027-03-25', headers: auth(ceo),
  });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json().skipped, false);
  assert.ok(
    !run.json().lists.some((l: { deadline: string }) => l.deadline === '2027-04-15'),
    'automatic-extension types never generate an extend/push decision'
  );
});

test('estimate reminders: T-7 email honors the per-client toggle (default ON)', async () => {
  const onId = await makeClient('Estimateon', 'estimate-on@example.test');
  const offId = await makeClient('Estimateoff', 'estimate-off@example.test', 'es');
  // Portal-active clients receive reminders (spec: portal notification setting).
  await app.db.query(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2), ($3, $4)`,
    [onId, 'estimate-on@example.test', offId, 'estimate-off@example.test']);
  await app.db.query(`UPDATE contacts SET estimate_reminders_enabled = false WHERE id = $1`, [offId]);

  // Default is ON straight from the schema.
  const flag = await app.db.query(`SELECT estimate_reminders_enabled FROM contacts WHERE id = $1`, [onId]);
  assert.equal(flag.rows[0].estimate_reminders_enabled, true);

  // 2026-09-08 is T-7 before the Q3 date (Sep 15).
  const run = await app.inject({
    method: 'POST', url: '/jobs/estimate-reminder?asOf=2026-09-08', headers: auth(ceo),
  });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json().skipped, false);
  assert.ok(run.json().sent >= 1);
  const onMail = sentMail.filter((m) => m.to === 'estimate-on@example.test');
  assert.ok(onMail.some((m) => /estimated tax payment due 2026-09-15/i.test(m.subject)), 'toggle-on client reminded');
  assert.ok(!sentMail.some((m) => m.to === 'estimate-off@example.test'), 'toggle-off client left alone');

  // Idempotent per date; non-T-7 dates send nothing.
  assert.equal(
    (await app.inject({ method: 'POST', url: '/jobs/estimate-reminder?asOf=2026-09-08', headers: auth(ceo) })).json().skipped,
    true
  );
  const quiet = await app.inject({ method: 'POST', url: '/jobs/estimate-reminder?asOf=2026-09-09', headers: auth(ceo) });
  assert.equal(quiet.json().sent, 0);
});


// ── M26 flow 3: auto-extension batch, swept from the DEADLINE TABLE ──────────
// Brian's correction (2026-08-09): cutoff = original due date − offset (default
// 10 days), derived per engagement. No fixed dates to rot; every return type,
// including fiscal-year filers and types that don't exist yet, sweeps correctly.

test('sweep window derives from the deadline table: T-10 per engagement, never after the deadline', async () => {
  const { sweepWindow } = await import('../src/modules/tax/extension-batch.ts');

  // 2026 tax year, calendar filers. Deadlines are business-day rolled first,
  // then the offset applies — so the sweep always lands 10 days before the
  // date that actually matters.
  assert.deepEqual(sweepWindow('1065', 2026, 12, 10), { deadline: '2027-03-15', cutoff: '2027-03-05' });
  assert.deepEqual(sweepWindow('1120s', 2026, 12, 10), { deadline: '2027-03-15', cutoff: '2027-03-05' });
  assert.deepEqual(sweepWindow('1040', 2026, 12, 10), { deadline: '2027-04-15', cutoff: '2027-04-05' });
  assert.deepEqual(sweepWindow('1120', 2026, 12, 10), { deadline: '2027-04-15', cutoff: '2027-04-05' });
  // 990s handle themselves — no settings entry, no code change.
  assert.deepEqual(sweepWindow('990', 2026, 12, 10), { deadline: '2027-05-17', cutoff: '2027-05-07' });
  // Fiscal-year filer: FYE June 1120 is due Oct 15 → sweeps Oct 5.
  assert.deepEqual(sweepWindow('1120', 2026, 6, 10), { deadline: '2026-10-15', cutoff: '2026-10-05' });
  // Admin can widen the offset without touching code.
  assert.deepEqual(sweepWindow('1065', 2026, 12, 21), { deadline: '2027-03-15', cutoff: '2027-02-22' });
  // Out of scope: FBAR extends automatically, W-7 has no standalone deadline.
  assert.equal(sweepWindow('fbar', 2026, 12, 10), null);
  assert.equal(sweepWindow('w7_itin', 2026, 12, 10), null);
});

test('auto-extension batch: sweeps per deadline, notifies clients, and filing is BLOCKED until Brian approves', async () => {
  // A 2026 partnership (Mar 15 → sweep Mar 5) and a 2026 individual
  // (Apr 15 → sweep Apr 5), both still missing documents.
  const partner = await makeClient('Batchbiz', 'batch-biz@example.test');
  const bizTe = await makeTaxEngagement(partner, '1065', 2026);
  const indiv = await makeClient('Batchind', 'batch-ind@example.test');
  const indTe = await makeTaxEngagement(indiv, '1040', 2026);
  // A third with documents already in — must NEVER be swept.
  const ready = await makeClient('Batchready', 'batch-ready@example.test');
  const readyTe = await makeTaxEngagement(ready, '1065', 2026);
  await app.db.query(`UPDATE tax_engagements SET docs_received_at = now() WHERE id = $1`, [readyTe]);

  // Too early: 15 days out, nothing sweeps.
  const early = await app.inject({
    method: 'POST', url: '/jobs/auto-extension-batch?asOf=2027-02-28', headers: auth(ceo),
  });
  assert.equal(early.statusCode, 200, early.body);
  assert.equal(early.json().added, 0, 'the window has not opened yet');

  // Mar 5 (T-10 from Mar 15): the 1065 sweeps; the 1040 does not (its own
  // window opens a month later).
  const mailBefore = sentMail.length;
  const run = await app.inject({
    method: 'POST', url: '/jobs/auto-extension-batch?asOf=2027-03-05', headers: auth(ceo),
  });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json().added, 1, 'only the March filer, and only the one missing docs');
  assert.equal(run.json().notified, 1);
  const notice = sentMail.slice(mailBefore).find((m) => m.to === 'batch-biz@example.test');
  assert.ok(notice, 'client told a protective extension is coming');
  assert.match(notice!.text, /normal/i);

  const batches = await app.inject({ method: 'GET', url: '/extension-batches', headers: auth(preparer) });
  const marBatch = batches.json().batches.find((b: { deadline_date: string }) => b.deadline_date === '2027-03-15');
  assert.ok(marBatch, 'batch is keyed on the deadline it protects');
  assert.equal(marBatch.cutoff_date, '2027-03-05');
  assert.equal(marBatch.status, 'draft');
  assert.equal(marBatch.items, 1);

  // Brian's review task exists, urgent, and names the deadline.
  const reviewTask = await app.db.query<{ id: string; priority: number; title: string }>(
    `SELECT id, priority, title FROM tasks WHERE source_type = 'extension_batch_review' AND source_id = $1`,
    [marBatch.id]
  );
  assert.equal(reviewTask.rows.length, 1);
  assert.equal(reviewTask.rows[0]!.priority, 2);
  assert.match(reviewTask.rows[0]!.title, /2027-03-15/);

  // THE GATE: a preparer cannot file while the batch is draft.
  const premature = await app.inject({
    method: 'POST', url: `/extension-batches/${marBatch.id}/items/${bizTe}/filed?asOf=2027-03-05`,
    headers: auth(preparer),
  });
  assert.equal(premature.statusCode, 409, premature.body);
  assert.equal(premature.json().error, 'batch_not_approved');

  // Same-day rerun is date-guarded. A LATER day inside the window re-runs and
  // adds nothing new (idempotent per engagement) — a missed day self-corrects.
  assert.equal(
    (await app.inject({ method: 'POST', url: '/jobs/auto-extension-batch?asOf=2027-03-05', headers: auth(ceo) })).json().skipped,
    true
  );
  const midWindow = await app.inject({
    method: 'POST', url: '/jobs/auto-extension-batch?asOf=2027-03-09', headers: auth(ceo),
  });
  assert.equal(midWindow.json().added, 0, 'already swept — never double-added');
  const oneReviewTask = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'extension_batch_review' AND source_id = $1`,
    [marBatch.id]
  );
  assert.equal(oneReviewTask.rows[0]!.n, 1, 'one review task per batch, however many days it grows over');

  // THE CORRECTION: on/after the deadline the sweep refuses — a protective
  // extension filed late protects nobody.
  const tooLate = await app.inject({
    method: 'POST', url: '/jobs/auto-extension-batch?asOf=2027-03-15', headers: auth(ceo),
  });
  assert.equal(tooLate.json().added, 0, 'never sweeps on or after the deadline');

  // The 1040's own window opens Apr 5 → its own batch, keyed on Apr 15.
  const aprRun = await app.inject({
    method: 'POST', url: '/jobs/auto-extension-batch?asOf=2027-04-05', headers: auth(ceo),
  });
  assert.equal(aprRun.json().added, 1, 'the individual filer sweeps on its own clock');
  const aprBatch = (await app.inject({ method: 'GET', url: '/extension-batches', headers: auth(preparer) }))
    .json().batches.find((b: { deadline_date: string }) => b.deadline_date === '2027-04-15');
  assert.ok(aprBatch, 'a separate batch per deadline');

  // Brian approves the March batch → review task closes, filing opens.
  const approve = await app.inject({
    method: 'POST', url: `/extension-batches/${marBatch.id}/approve`, headers: auth(ceo),
  });
  assert.equal(approve.statusCode, 200, approve.body);
  assert.equal(approve.json().items, 1);
  const closedTask = await app.db.query<{ status: string }>(`SELECT status FROM tasks WHERE id = $1`, [reviewTask.rows[0]!.id]);
  assert.equal(closedTask.rows[0]!.status, 'completed', 'approval closes the review work item');

  // Preparer files → DERIVED extended deadline, batch completes.
  const filed = await app.inject({
    method: 'POST', url: `/extension-batches/${marBatch.id}/items/${bizTe}/filed?asOf=2027-03-06`,
    headers: auth(preparer),
  });
  assert.equal(filed.statusCode, 200, filed.body);
  assert.equal(filed.json().extendedDeadline, '2027-09-15', '1065 extension = Sep 15 from the table');
  assert.equal(filed.json().batchComplete, true);
  const teRow = await app.db.query<{ extension_filed: boolean; extended_deadline: string }>(
    `SELECT extension_filed, extended_deadline::text AS extended_deadline FROM tax_engagements WHERE id = $1`,
    [bizTe]
  );
  assert.equal(teRow.rows[0]!.extension_filed, true);
  assert.equal(teRow.rows[0]!.extended_deadline, '2027-09-15');
  const batchRow = await app.db.query<{ status: string }>(`SELECT status FROM extension_batches WHERE id = $1`, [marBatch.id]);
  assert.equal(batchRow.rows[0]!.status, 'filed');

  // Brian can pull an engagement OUT before filing; a pulled item can't file.
  const pulled = await app.inject({
    method: 'DELETE', url: `/extension-batches/${aprBatch.id}/items/${indTe}`, headers: auth(ceo),
  });
  assert.equal(pulled.statusCode, 200, pulled.body);
  await app.inject({ method: 'POST', url: `/extension-batches/${aprBatch.id}/approve`, headers: auth(ceo) });
  const refiled = await app.inject({
    method: 'POST', url: `/extension-batches/${aprBatch.id}/items/${indTe}/filed?asOf=2027-04-06`,
    headers: auth(preparer),
  });
  assert.equal(refiled.statusCode, 404, 'a pulled engagement cannot be filed through the batch');
});

test('auto-extension batch respects the extension_notices kill switch (the sweep still happens)', async () => {
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'extension_notices'`);
  const quiet = await makeClient('Batchquiet', 'batch-quiet@example.test');
  await makeTaxEngagement(quiet, '1065', 2027); // deadline 2028-03-15 → sweep 2028-03-05

  const mailBefore = sentMail.length;
  const run = await app.inject({
    method: 'POST', url: '/jobs/auto-extension-batch?asOf=2028-03-05', headers: auth(ceo),
  });
  assert.equal(run.statusCode, 200, run.body);
  assert.equal(run.json().added, 1, 'the engagement is still swept into the batch');
  assert.equal(run.json().notified, 0);
  assert.equal(run.json().suppressed, 1, 'the client notice was suppressed and counted');
  assert.equal(
    sentMail.slice(mailBefore).filter((m) => m.to === 'batch-quiet@example.test').length,
    0,
    'nothing reached the client'
  );
  await app.db.query(`UPDATE automations SET enabled = true WHERE key = 'extension_notices'`);
});
