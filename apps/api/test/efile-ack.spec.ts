/*
 * E-FILE ACKNOWLEDGMENT AUTOMATION (2026-09-12, Brian's ruling) and the preparer of record.
 *
 * The sabotage Brian named: a report with one accepted, one rejected, one unmatched row →
 * exactly one queued send, two tasks, zero guesses. Then: release, the gate OFF holds it and
 * records that; armed, it sends in the client's language; federal and state are two messages
 * and the return records both; a rejection never becomes a client email; the preparer of record
 * is set at filing and cannot be changed after. Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, signed8879OnFile, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { ingestReport, parseAtxReport, releaseReport, holdRow } from '../src/modules/tax/efile-ack.ts';
import { transitionStage } from '../src/modules/tax/pipeline.ts';
import { drainOutbox } from '../src/outbox.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff;
const sent: MailMessage[] = [];

before(async () => {
  config = await createTestConfig('efile_ack');
  const mailer: Mailer = { transport: 'console', async send(m) { sent.push(m); return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  ana = await makeStaff(app.db, config, { email: 'ana@example.test', name: 'Synthetic Preparer', role: 'tax_preparer', password: 'tax_preparer-password-1234' });
  await makeStaff(app.db, config, { email: 'ceo-ack@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-12345678' });
});
after(async () => { await app.close(); });

async function arm(on: boolean): Promise<void> {
  await app.db.query(`UPDATE automations SET enabled = $1 WHERE key = 'efile_acknowledgment'`, [on]);
}

/** A return at `filed`, through the real transition, with the preparer of record set at filing. */
async function filedReturn(first: string, last: string, opts: { language?: 'en' | 'es'; taxYear?: number; returnType?: string; ssnLast4?: string } = {}) {
  const c = await makeContact(app.db, { firstName: first, lastName: last, email: `${first}.${last}@example.test`.toLowerCase(), language: opts.language ?? 'en' });
  if (opts.ssnLast4) await app.db.query(`UPDATE contacts SET ssn_last4 = $2 WHERE id = $1`, [c.id, opts.ssnLast4]);
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status) VALUES ($1, 'tax', $2, 'active') RETURNING id`,
    [c.id, `${opts.taxYear ?? 2025} return`]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, preparer_id, engagement_letter_signed_at, estimate_locked_at)
     VALUES ($1, $2, $3::return_type, 'ready_to_file', $4, now(), now()) RETURNING id`,
    [eng.rows[0]!.id, opts.taxYear ?? 2025, opts.returnType ?? '1040', ana.id]
  );
  await signed8879OnFile(app, te.rows[0]!.id, ana.id);
  await transitionStage(app, { staffId: ana.id, label: ana.fullName }, te.rows[0]!.id, 'filed', { preparerPtinHolderId: ana.id });
  return { contactId: c.id, taxEngagementId: te.rows[0]!.id };
}

const HEADER = 'Client Name,Tax Year,Return Type,Agency,Status,Submission ID,Ack Date,Reject Code,Reject Reason';

test('the parser reads ATX columns by name and refuses a file that is not an acknowledgment report', () => {
  const p = parseAtxReport(`${HEADER}\n"Doe, Jane",2025,1040,Federal,Accepted,S123,09/11/2026,,\n"Doe, Jane",2025,1040,IL,Accepted,S124,09/11/2026,,`);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0]!.jurisdiction, 'federal');
  assert.equal(p.rows[1]!.jurisdiction, 'state');
  assert.equal(p.rows[1]!.stateCode, 'IL');
  assert.equal(p.rows[0]!.acknowledgedOn, '2026-09-11');
  assert.throws(() => parseAtxReport('Invoice,Amount\nSA-1,100'), /does not look like an ATX acknowledgment report/);
});

test('one accepted, one rejected, one unmatched → one queued send, two tasks, zero guesses', async () => {
  await arm(false);
  const ok = await filedReturn('Accepted', 'Client');
  const rej = await filedReturn('Rejected', 'Client');
  const report = [
    HEADER,
    '"Accepted, Client",2025,1040,Federal,Accepted,S1,09/11/2026,,',
    '"Rejected, Client",2025,1040,Federal,Rejected,S2,09/11/2026,R0000-500,SSN and name do not match',
    '"Nobody, Here",2025,1040,Federal,Accepted,S3,09/11/2026,,',
  ].join('\n');
  const r = await ingestReport(app, { id: ana.id, label: ana.fullName }, { filename: 'ack.csv', text: report, today: '2026-09-11' });
  assert.equal(r.rows, 3);
  assert.equal(r.queued, 1, 'exactly one send queued');
  assert.equal(r.tasks, 2, 'the rejection and the unmatched row are tasks');
  assert.equal(sent.length, 0, 'nothing sent on upload');

  const rows = await app.db.query<{ client_name_raw: string; disposition: string; task_id: string | null; tax_engagement_id: string | null }>(
    `SELECT client_name_raw, disposition::text AS disposition, task_id, tax_engagement_id FROM efile_acknowledgments WHERE report_id = $1 ORDER BY row_index`, [r.reportId]);
  assert.deepEqual(rows.rows.map((x) => x.disposition), ['queued', 'task', 'task']);
  assert.equal(rows.rows[0]!.tax_engagement_id, ok.taxEngagementId);
  assert.equal(rows.rows[2]!.tax_engagement_id, null, 'the unmatched row is matched to nothing — no guess');
  assert.ok(rows.rows[1]!.task_id && rows.rows[2]!.task_id, 'both tasks exist');

  // The rejection took the existing owned path: perfection clock + efile_reject task, no email.
  const te = await app.db.query<{ stage: string; perfection_deadline: string | null; federal_accepted_on: string | null }>(
    `SELECT stage::text AS stage, perfection_deadline::text AS perfection_deadline, federal_accepted_on::text AS federal_accepted_on FROM tax_engagements WHERE id = $1`, [rej.taxEngagementId]);
  assert.equal(te.rows[0]!.stage, 'rejected');
  assert.ok(te.rows[0]!.perfection_deadline);
  // The accepted one records the date and completed.
  const okTe = await app.db.query<{ stage: string; federal_accepted_on: string | null }>(`SELECT stage::text AS stage, federal_accepted_on::text AS federal_accepted_on FROM tax_engagements WHERE id = $1`, [ok.taxEngagementId]);
  assert.equal(okTe.rows[0]!.stage, 'completed');
  assert.equal(okTe.rows[0]!.federal_accepted_on, '2026-09-11');

  // The unmatched task names the row and why.
  const task = await app.db.query<{ title: string; description: string; assigned_staff_id: string | null }>(`SELECT title, description, assigned_staff_id FROM tasks WHERE id = $1`, [rows.rows[2]!.task_id]);
  assert.match(task.rows[0]!.title, /Nobody, Here/);
  assert.match(task.rows[0]!.description, /row 3/);
  assert.match(task.rows[0]!.description, /no 2025 1040 return in SAOS/);
  assert.equal(task.rows[0]!.assigned_staff_id, ana.id, 'owned by the tax preparer');

  // Release with the gate OFF: recorded as held by the automation, nothing sent.
  const rel = await releaseReport(app, { id: ana.id, label: ana.fullName }, r.reportId);
  assert.equal(rel.enqueued, 1);
  await drainOutbox(app);
  assert.equal(sent.length, 0, 'the gate is off');
  const after = await app.db.query<{ disposition: string }>(`SELECT disposition::text AS disposition FROM efile_acknowledgments WHERE report_id = $1 AND row_index = 1`, [r.reportId]);
  assert.equal(after.rows[0]!.disposition, 'suppressed');
  const audit = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'efile_ack.notice_suppressed'`);
  assert.equal(audit.rows.length, 1);
});

test('federal and state acknowledge separately, in the client\'s language, and the return records both', async () => {
  await arm(true);
  sent.length = 0;
  const es = await filedReturn('Federico', 'Estado', { language: 'es' });
  const report = [
    HEADER,
    'Federico Estado,2025,1040,Federal,Accepted,S10,09/12/2026,,',
    'Federico Estado,2025,1040,IL,Accepted,S11,09/12/2026,,',
  ].join('\n');
  const r = await ingestReport(app, { id: ana.id, label: ana.fullName }, { filename: 'ack2.csv', text: report, today: '2026-09-12' });
  assert.equal(r.queued, 2);
  await releaseReport(app, { id: ana.id, label: ana.fullName }, r.reportId);
  await drainOutbox(app);
  assert.equal(sent.length, 2, 'two messages: federal and state');
  const subjects = sent.map((m) => m.subject ?? '').sort();
  assert.ok(subjects.some((s) => /IRS|federal/i.test(s)), 'one is the federal message');
  assert.ok(subjects.some((s) => /IL|estatal|estado/i.test(s)), 'one is the state message');
  for (const m of sent) assert.doesNotMatch(m.subject ?? '', /Your .* return/, 'Spanish client, Spanish subject');

  const te = await app.db.query<{ federal_accepted_on: string | null; state_accepted_on: string | null; state_accepted_code: string | null }>(
    `SELECT federal_accepted_on::text AS federal_accepted_on, state_accepted_on::text AS state_accepted_on, state_accepted_code FROM tax_engagements WHERE id = $1`, [es.taxEngagementId]);
  assert.equal(te.rows[0]!.federal_accepted_on, '2026-09-12');
  assert.equal(te.rows[0]!.state_accepted_on, '2026-09-12');
  assert.equal(te.rows[0]!.state_accepted_code, 'IL');
});

test('a held row does not send when the report is released; the same file twice is the same report', async () => {
  await arm(true);
  sent.length = 0;
  await filedReturn('Holding', 'Pattern');
  const report = `${HEADER}\nHolding Pattern,2025,1040,Federal,Accepted,S20,09/12/2026,,`;
  const r = await ingestReport(app, { id: ana.id, label: ana.fullName }, { filename: 'ack3.csv', text: report });
  const row = await app.db.query<{ id: string }>(`SELECT id FROM efile_acknowledgments WHERE report_id = $1`, [r.reportId]);
  await holdRow(app, { id: ana.id, label: ana.fullName }, row.rows[0]!.id, true);
  const rel = await releaseReport(app, { id: ana.id, label: ana.fullName }, r.reportId);
  assert.equal(rel.enqueued, 0);
  assert.equal(rel.held, 1);
  await drainOutbox(app);
  assert.equal(sent.length, 0);

  const again = await ingestReport(app, { id: ana.id, label: ana.fullName }, { filename: 'ack3-copy.csv', text: report });
  assert.equal(again.alreadyIngested, true);
  assert.equal(again.reportId, r.reportId);
});

test('two clients with the same name and year is not a match — a task, never a guess', async () => {
  await filedReturn('Twin', 'Name', { ssnLast4: '1111' });
  await filedReturn('Twin', 'Name', { ssnLast4: '2222' });
  const r = await ingestReport(app, { id: ana.id, label: ana.fullName }, { filename: 'ack4.csv', text: `${HEADER}\nTwin Name,2025,1040,Federal,Accepted,S30,09/12/2026,,` });
  assert.equal(r.queued, 0);
  assert.equal(r.tasks, 1);
  const note = await app.db.query<{ disposition_note: string }>(`SELECT disposition_note FROM efile_acknowledgments WHERE report_id = $1`, [r.reportId]);
  assert.match(note.rows[0]!.disposition_note, /2 returns in SAOS could be/);
});

test('the preparer of record is set by the 8879 upload, required at filing, and cannot be changed after', async () => {
  const c = await makeContact(app.db, { firstName: 'Ptin', lastName: 'Holder', email: 'ptin@example.test' });
  const eng = await app.db.query<{ id: string }>(`INSERT INTO engagements (contact_id, service_line, title, status) VALUES ($1, 'tax', '2025', 'active') RETURNING id`, [c.id]);
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, preparer_id, engagement_letter_signed_at, estimate_locked_at)
     VALUES ($1, 2025, '1040', 'ready_to_file', $2, now(), now()) RETURNING id`, [eng.rows[0]!.id, ana.id]);
  const id = te.rows[0]!.id;

  // No 8879 on file: filing is refused, whoever is named.
  await assert.rejects(() => transitionStage(app, { staffId: ana.id, label: ana.fullName }, id, 'filed', { preparerPtinHolderId: ana.id }), /8879/);

  // The upload sets the holder and authorizes; filing then goes through.
  await signed8879OnFile(app, id, ana.id);
  const set = await app.db.query<{ preparer_ptin_holder_id: string; preparer_ptin_holder_set_at: Date | null }>(`SELECT preparer_ptin_holder_id, preparer_ptin_holder_set_at FROM tax_engagements WHERE id = $1`, [id]);
  assert.equal(set.rows[0]!.preparer_ptin_holder_id, ana.id, 'whose PTIN is on it, recorded at upload');
  assert.ok(set.rows[0]!.preparer_ptin_holder_set_at);
  await transitionStage(app, { staffId: ana.id, label: ana.fullName }, id, 'filed', {});

  const other = await makeStaff(app.db, config, { email: 'other-prep@example.test', name: 'Synthetic Other', role: 'tax_preparer', password: 'tax_preparer-password-5678' });
  await assert.rejects(
    () => app.db.query(`UPDATE tax_engagements SET preparer_ptin_holder_id = $2 WHERE id = $1`, [id, other.id]),
    /preparer_of_record_immutable/,
    'the database refuses the change, not just the route'
  );
});
