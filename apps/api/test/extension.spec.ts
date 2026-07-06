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
import { extendedDeadline, originalDeadline, addDays, daysBetween } from '../src/modules/tax/deadlines.ts';

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
    // [returnType, taxYear, fyeMonth, original, extended]
    ['1040', 2025, 12, '2026-04-15', '2026-10-15'],
    ['1065', 2025, 12, '2026-03-15', '2026-09-15'],
    ['1120s', 2025, 12, '2026-03-15', '2026-09-15'],
    ['1120', 2025, 12, '2026-04-15', '2026-10-15'],
    ['990', 2025, 12, '2026-05-15', '2026-11-15'],
    ['990ez', 2025, 12, '2026-05-15', '2026-11-15'],
    // Fiscal-year filers: original = 15th of Nth month after FYE; extended = +6mo.
    ['1120', 2026, 6, '2026-10-15', '2027-04-15'],
    ['990', 2026, 9, '2027-02-15', '2027-08-15'],
    ['1065', 2026, 3, '2026-06-15', '2026-12-15'],
    ['1120s', 2026, 11, '2027-02-15', '2027-08-15'],
    // W-7 has no standalone deadline.
    ['w7_itin', 2025, 12, null, null],
  ];
  for (const [rt, year, fye, orig, ext] of cases) {
    assert.equal(originalDeadline(rt as never, year, fye), orig, `${rt}/${year}/fye${fye} original`);
    assert.equal(extendedDeadline(rt as never, year, fye), ext, `${rt}/${year}/fye${fye} extended`);
  }
  // Date helpers.
  assert.equal(addDays('2026-03-15', -21), '2026-02-22');
  assert.equal(daysBetween('2026-08-20', '2026-09-15'), 26);
});

test('T-21 decision list job fires per deadline, once per day, and the list is queryable', async () => {
  const clientA = await makeClient('Partnership', 'partnership-ext@example.test');
  const engA = await makeTaxEngagement(clientA, '1065', 2025); // deadline 2026-03-15
  const clientB = await makeClient('Individual', 'individual-ext@example.test');
  await makeTaxEngagement(clientB, '1040', 2025); // deadline 2026-04-15

  // T-21 before Mar 15 → only the 1065 fires.
  const run1 = await app.inject({
    method: 'POST', url: '/jobs/extension-decision-list?asOf=2026-02-22', headers: auth(ceo),
  });
  assert.equal(run1.statusCode, 200, run1.body);
  assert.equal(run1.json().skipped, false);
  assert.deepEqual(run1.json().lists, [{ deadline: '2026-03-15', count: 1 }]);

  // Same day again → idempotent skip (safe across restarts).
  const rerun = await app.inject({
    method: 'POST', url: '/jobs/extension-decision-list?asOf=2026-02-22', headers: auth(ceo),
  });
  assert.equal(rerun.json().skipped, true);

  // Notifications reached CEO + preparer roles.
  const notes = await app.db.query(
    `SELECT count(*)::int AS n FROM notifications WHERE type = 'extension_decision_list'`
  );
  assert.ok(notes.rows[0].n >= 2, 'decision-list notifications for ceo + tax_preparer');

  // The list endpoint returns the 1065, sorted by preparer.
  const list = await app.inject({
    method: 'GET', url: '/tax-engagements/extension-decision-list?deadline=2026-03-15', headers: auth(preparer),
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
});
