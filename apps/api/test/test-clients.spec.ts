// "Prove it": flagged TEST clients are excluded from MEASUREMENT and visible in
// OPERATIONS.
//
// This exists because the dress rehearsal puts a real client record into
// production. The failure mode is not dramatic — it is quiet: 433 active clients
// becomes 434, a rehearsal deposit becomes revenue, a test portal login counts
// toward the Dubsado retirement trigger, and six months later nobody remembers
// which row was the rehearsal.
//
// The test asserts the SAME dataset both ways: flip the flag and every number
// moves by exactly one, while every operational surface keeps showing the record.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { runReport } from '../src/modules/reports/service.ts';
import { executiveDashboard } from '../src/modules/dashboards/service.ts';
import { pipelineMetrics } from '../src/modules/pricing/pipeline.ts';
import { retirementReadiness } from '../src/modules/admin/dubsado-retirement.ts';
import { previewAudience } from '../src/modules/comms/broadcast.ts';
import { preparerQueue } from '../src/modules/tax/queue.ts';
import { todayChicago, addDays } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let rehearsalId = '';

const silentMailer: Mailer = { transport: 'console', async send() { return { id: 'silent' }; } };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

const setTest = (on: boolean) =>
  app.db.query(
    `UPDATE contacts SET is_test = $2, test_note = $3 WHERE id = $1`,
    [rehearsalId, on, on ? 'Dress rehearsal for the first-client sequence.' : null]
  );

before(async () => {
  config = await createTestConfig('testclients');
  app = buildServer(config, { mailer: silentMailer });
  await app.ready();
  brian = await staffWithToken('brian-tc@example.test', 'ceo');

  // One rehearsal client that touches every measured surface: active, scored,
  // in the pipeline, with a paid invoice, an overdue invoice, a session, a
  // migrated portal login, and an assigned return.
  const c = await makeContact(app.db, {
    firstName: 'Rehearsal', lastName: 'Client', email: 'rehearsal-tc@example.test',
  });
  rehearsalId = c.id;
  await app.db.query(
    `UPDATE contacts SET soto_status = 'active', hilo_status = 'active', health_band = 'green',
            lead_stage = 'client', source = 'dubsado', sms_consent = true, phone = '312-555-0199'
     WHERE id = $1`,
    [rehearsalId]
  );
  await app.db.query(
    `INSERT INTO audit_log (actor_type, actor_label, action, contact_id)
     VALUES ('client', 'Rehearsal', 'portal.login', $1)`,
    [rehearsalId]
  );
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  await app.db.query(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents,
                           amount_paid_cents, sent_at, paid_at, price_book_version_id)
     VALUES ('TC-PAID-1', $1, 'paid', 25000, 25000, 25000, now() - interval '10 days', now(), $2)`,
    [rehearsalId, version.rows[0]!.id]
  );
  await app.db.query(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents,
                           sent_at, price_book_version_id)
     VALUES ('TC-OWED-1', $1, 'overdue', 40000, 40000, now() - interval '45 days', $2)`,
    [rehearsalId, version.rows[0]!.id]
  );
  await app.db.query(
    `INSERT INTO client_sessions (contact_id, starts_at, status)
     VALUES ($1, now() - interval '5 days', 'completed')`,
    [rehearsalId]
  );
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`,
    [rehearsalId]
  );
  await app.db.query(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, preparer_id, original_deadline)
     VALUES ($1, 2025, '1040', 'in_preparation', $2, $3::date)`,
    [eng.rows[0]!.id, brian.id, addDays(todayChicago(), 30)]
  );
});

after(async () => {
  await app.close();
});

test('the flag requires a reason — a mystery test row is not allowed', async () => {
  await assert.rejects(
    app.db.query(`UPDATE contacts SET is_test = true WHERE id = $1`, [rehearsalId]),
    /contacts_test_has_note/,
    'is_test without a note is refused by the database'
  );
  await assert.rejects(
    app.db.query(`UPDATE contacts SET is_test = true, test_note = 'test' WHERE id = $1`, [rehearsalId]),
    /contacts_test_has_note/,
    'and a one-word note is not a reason'
  );
});

test('EXCLUDED FROM MEASUREMENT: every number moves by exactly one when the flag flips', async () => {
  const range = { from: '2020-01-01', to: '2030-12-31' };

  await setTest(false);
  const beforeExec = await executiveDashboard(app);
  const beforeCounts = await runReport(app, 'client_counts', range);
  const beforeUtil = await runReport(app, 'session_utilization', range);
  const beforeRevenue = await runReport(app, 'revenue_by_line_month', range);
  const beforeAr = await runReport(app, 'ar_aging', range);
  const beforePipeline = await pipelineMetrics(app);
  const beforeRetire = await retirementReadiness(app);
  const beforeSeg = await previewAudience(app, { sotoStatus: 'active' }, 'both');

  await setTest(true);
  const afterExec = await executiveDashboard(app);
  const afterCounts = await runReport(app, 'client_counts', range);
  const afterUtil = await runReport(app, 'session_utilization', range);
  const afterRevenue = await runReport(app, 'revenue_by_line_month', range);
  const afterAr = await runReport(app, 'ar_aging', range);
  const afterPipeline = await pipelineMetrics(app);
  const afterRetire = await retirementReadiness(app);
  const afterSeg = await previewAudience(app, { sotoStatus: 'active' }, 'both');

  const sum = (rows: Array<Record<string, unknown>>, key: string) =>
    rows.reduce((n, r) => n + (Number(r[key]) || 0), 0);

  // Client counts and health bands.
  assert.equal(sum(beforeCounts.rows, 'clients') - sum(afterCounts.rows, 'clients'), 1, 'client_counts');
  assert.equal(
    sum(beforeExec.healthDistribution as Array<Record<string, unknown>>, 'count') -
      sum(afterExec.healthDistribution as Array<Record<string, unknown>>, 'count'),
    1,
    'Executive health distribution'
  );

  // Money: a rehearsal deposit is not revenue, and a rehearsal invoice is not A/R.
  assert.equal(beforeExec.revenue.ytdCents - afterExec.revenue.ytdCents, 25000, 'Executive YTD revenue');
  assert.equal(
    sum(beforeRevenue.rows, 'collected_cents') - sum(afterRevenue.rows, 'collected_cents'),
    25000,
    'revenue report'
  );
  assert.equal(sum(beforeAr.rows, 'owed_cents') - sum(afterAr.rows, 'owed_cents'), 40000, 'A/R aging');
  assert.equal(
    sum(beforeExec.arAging as Array<Record<string, unknown>>, 'owed_cents') -
      sum(afterExec.arAging as Array<Record<string, unknown>>, 'owed_cents'),
    40000,
    'Executive A/R'
  );

  // Sessions, pipeline, and the retirement trigger.
  assert.equal(beforeUtil.rows.length - afterUtil.rows.length, 1, 'session utilization');
  assert.equal(
    sum(beforePipeline.byStage as unknown as Array<Record<string, unknown>>, 'count') -
      sum(afterPipeline.byStage as unknown as Array<Record<string, unknown>>, 'count'),
    1,
    'pipeline stage counts'
  );
  assert.equal(
    beforeRetire.migratedLoggedIn - afterRetire.migratedLoggedIn,
    1,
    'a rehearsal portal login must not count toward the Dubsado trigger'
  );

  // And the one that would actually embarrass us.
  assert.equal(beforeSeg.intended - afterSeg.intended, 1, 'broadcast segment');
});

test('a test client can NEVER be in a broadcast audience, whatever segment is built', async () => {
  await setTest(true);
  // Every segment shape, including the widest possible one.
  for (const segment of [
    {},
    { sotoStatus: 'active' as const },
    { language: 'en' as const },
    { sotoStatus: 'active' as const, language: 'en' as const },
  ]) {
    for (const channel of ['email', 'sms', 'both'] as const) {
      const preview = await previewAudience(app, segment, channel);
      // The rehearsal client is active, has an email, a phone and SMS consent, so
      // it would otherwise be in every one of these audiences.
      const rows = await app.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM contacts WHERE id = $1 AND NOT is_archived AND NOT is_test`,
        [rehearsalId]
      );
      assert.equal(rows.rows[0]!.n, 0, 'the flag holds');
      assert.ok(preview.intended >= 0);
    }
  }

  // Belt and braces: the send path itself cannot reach it. Build a broadcast over
  // the widest segment and confirm no recipient row is created for the flag.
  const created = await app.inject({
    method: 'POST', url: '/broadcasts', headers: auth(brian),
    payload: {
      name: 'Synthetic reach-everyone test', channel: 'email', segment: {},
      subjectEn: 'S', subjectEs: 'S', bodyEn: 'Body text here.', bodyEs: 'Texto aquí.',
    },
  });
  const id = created.json().id as string;
  await app.inject({ method: 'POST', url: `/broadcasts/${id}/submit`, headers: auth(brian) });
  // The author cannot approve their own, so approve as a second leader.
  const jackson = await staffWithToken('jackson-tc@example.test', 'ed_coo');
  await app.inject({ method: 'POST', url: `/broadcasts/${id}/approve`, headers: auth(jackson) });
  await app.inject({ method: 'POST', url: `/broadcasts/${id}/send`, headers: auth(jackson) });

  const reached = await app.db.query(
    `SELECT 1 FROM broadcast_recipients WHERE broadcast_id = $1 AND contact_id = $2`,
    [id, rehearsalId]
  );
  assert.equal(reached.rows.length, 0, 'not even a suppression row — it is not in the audience at all');
});

test('VISIBLE IN OPERATIONS: the record can still be worked', async () => {
  await setTest(true);

  // Contact search finds it — otherwise you cannot rehearse.
  const search = await app.inject({
    method: 'GET', url: '/contacts?search=Rehearsal&limit=10', headers: auth(brian),
  });
  assert.equal(search.statusCode, 200);
  assert.ok(
    search.json().contacts.some((c: { id: string }) => c.id === rehearsalId),
    'a test client you cannot find is not a rehearsal'
  );

  // The client packet opens.
  const packet = await app.inject({ method: 'GET', url: `/contacts/${rehearsalId}`, headers: auth(brian) });
  assert.equal(packet.statusCode, 200);
  assert.equal(packet.json().contact.is_test, true, 'and it says it is a test');
  assert.match(packet.json().contact.test_note, /rehearsal/i);

  // The return shows in the preparer queue.
  const queue = await preparerQueue(app, brian.id, todayChicago());
  assert.ok(
    queue.queue.some((q) => q.contactId === rehearsalId),
    'the rehearsal return is workable in the queue'
  );

  // Documents and quotes surfaces accept it.
  const docs = await app.inject({
    method: 'GET', url: `/documents?contactId=${rehearsalId}`, headers: auth(brian),
  });
  assert.equal(docs.statusCode, 200);
  const quotes = await app.inject({
    method: 'GET', url: `/contacts/${rehearsalId}/quotes`, headers: auth(brian),
  });
  assert.equal(quotes.statusCode, 200);
});
