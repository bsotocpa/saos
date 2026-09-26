/*
 * E-FILE ACKNOWLEDGMENT AUTOMATION (2026-09-12, Brian's ruling), REBUILT AGAINST THE REAL ATX EXPORT
 * (R43, 2026-09-26), and the preparer of record.
 *
 * The sabotage Brian named: a report with one accepted, one rejected, one unmatched row → exactly
 * one queued send, one task (the rejection, because it matched), zero guesses — and the unmatched row
 * raises nothing, because a firm-wide export is mostly other people's returns. Then: release, the
 * gate OFF holds it and records that; armed, it sends in the client's language; federal and state
 * are two messages and the return records both; a rejection never becomes a client email; the
 * preparer of record is set at filing and cannot be changed after. R43: the identifier's last four
 * is the key and the name a tiebreak; a name that disagrees holds the row for a person; the
 * withdraw and purge doors; nothing persists a full identifier. Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, signed8879OnFile, type TestStaff } from './helpers.ts';
import { atxReport, atxRow, ATX_HEADER } from './atx.ts';
import type { Config } from '../src/config.ts';
import {
  chicagoToUtcIso, formFamily, ingestReport, maskIdentifiers, parseAtxReport, parseStatus, parseStatusDate, purgeReportIdentifiers,
  releaseReport, holdRow, splitYearSuffix, withdrawReport,
} from '../src/modules/tax/efile-ack.ts';
import { transitionStage } from '../src/modules/tax/pipeline.ts';
import { createTask } from '../src/modules/tasks/service.ts';
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

let n = 1000;
/** A return at `filed`, through the real transition, with the preparer of record set at filing and an SSN last four to match on. */
async function filedReturn(first: string, last: string, opts: { language?: 'en' | 'es'; taxYear?: number; returnType?: string; ssnLast4?: string; jurisdictions?: readonly string[] } = {}) {
  const ssnLast4 = opts.ssnLast4 ?? String(++n);
  const c = await makeContact(app.db, { firstName: first, lastName: last, email: `${first}.${last}.${n}@example.test`.toLowerCase(), language: opts.language ?? 'en' });
  await app.db.query(`UPDATE contacts SET ssn_last4 = $2 WHERE id = $1`, [c.id, ssnLast4]);
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
  // The filing declares its jurisdictions (2026-09-19 evening, ruling 2). These fixtures have no
  // address on file, so the default is federal alone; a spec that acknowledges a state says so.
  await transitionStage(app, { staffId: ana.id, label: ana.fullName }, te.rows[0]!.id, 'filed', {
    preparerPtinHolderId: ana.id, ...(opts.jurisdictions ? { jurisdictions: opts.jurisdictions } : {}),
  });
  return { contactId: c.id, taxEngagementId: te.rows[0]!.id, ssnLast4, exportName: `${last.toUpperCase()}, ${first.toUpperCase()} ${opts.taxYear ?? 2025}` };
}

const actor = () => ({ id: ana.id, label: ana.fullName });
async function ackRows(reportId: string) {
  const { rows } = await app.db.query<{ client_name_raw: string; disposition: string; task_id: string | null; tax_engagement_id: string | null; disposition_note: string; taxpayer_last4: string | null; tax_year: number | null }>(
    `SELECT client_name_raw, disposition::text AS disposition, task_id, tax_engagement_id, disposition_note, taxpayer_last4, tax_year FROM efile_acknowledgments WHERE report_id = $1 ORDER BY row_index`, [reportId]);
  return rows;
}

test('the parser reads the real export: header by name, identifiers to their last four, statuses, the Central status date, the year suffix, the form family', () => {
  const p = parseAtxReport(atxReport([
    atxRow({ name: 'DOE, JANE 2025', id: "'900001234", jurisdiction: 'Federal', type: '1040', status: 'Accepted', when: '9/15/2026 6:41:08 PM' }),
    atxRow({ name: 'DOE, JANE 2025', id: '900001234', jurisdiction: 'IL', type: 'IL 1040', status: 'AcceptedWithMessages', when: '9/15/2026 11:41:08 PM' }),
    atxRow({ name: 'SYNTHETIC SCORP LLC', id: '900000054', jurisdiction: 'IL', type: 'IL 1120-ST', status: 'TransmittedToAgency', when: '1/5/2026 8:00:00 AM' }),
    atxRow({ name: 'SYNTHETIC PARTNERS LLC', id: '900000061', jurisdiction: 'Federal', type: '7004', subType: 'Extension', status: 'RejectedByEfc' }),
  ]));
  assert.equal(p.rows.length, 4);
  const [fed, il, scorp, ext] = p.rows as [typeof p.rows[0], typeof p.rows[0], typeof p.rows[0], typeof p.rows[0]];
  assert.equal(fed.jurisdiction, 'federal');
  assert.equal(fed.taxpayerLast4, '1234', 'the apostrophe ATX prefixes is not part of the identifier');
  assert.equal(fed.nameFolded, 'doe jane');
  assert.equal(fed.yearSuffix, 2025);
  assert.equal(fed.formFamily, '1040');
  assert.equal(fed.status, 'accepted');
  assert.equal(fed.acknowledgedOn, '2026-09-15', 'the date as printed, Central');
  assert.equal(fed.statusAt, '2026-09-15T23:41:08.000Z', '6:41 PM CDT is 23:41 UTC');
  assert.equal(il.stateCode, 'IL');
  assert.equal(il.status, 'accepted');
  assert.equal(il.acceptedWithMessages, true, 'AcceptedWithMessages is accepted, flagged');
  assert.equal(il.acknowledgedOn, '2026-09-15', '11:41 PM Central is still the 15th as printed');
  assert.equal(il.statusAt, '2026-09-16T04:41:08.000Z', 'and the 16th in UTC');
  assert.equal(scorp.formFamily, '1120s', 'IL 1120-ST is the Illinois S corporation return');
  assert.equal(scorp.status, 'pending');
  assert.equal(scorp.yearSuffix, null, 'a business name carries no year');
  assert.equal(scorp.statusAt, '2026-01-05T14:00:00.000Z', '8 AM CST is 14:00 UTC');
  assert.equal(ext.kind, 'extension');
  assert.equal(ext.extensionForm, '7004');
  assert.equal(ext.status, 'rejected');
  for (const r of p.rows) assert.doesNotMatch(JSON.stringify(r), /9000012|90000005|90000006/, 'no parsed row carries more than the last four');

  // The old harness shape and an invoice are both refused whole, naming the headers found.
  assert.throws(() => parseAtxReport('Client Name,Tax Year,Return Type,Agency,Status\n"Doe, Jane",2025,1040,Federal,Accepted'), /does not look like the ATX E-Files export/);
  assert.throws(() => parseAtxReport('Invoice,Amount\nSA-1,100'), /no column for return name/);
  // The BOM on the real file does not hide the first header.
  assert.equal(parseAtxReport(`﻿${ATX_HEADER}\n`).rows.length, 0);

  assert.deepEqual(parseStatus('Created'), { status: 'pending', acceptedWithMessages: false });
  assert.deepEqual(parseStatus('Held'), { status: 'pending', acceptedWithMessages: false });
  assert.deepEqual(parseStatus('RejectedByAgency').status, 'rejected');
  assert.deepEqual(parseStatus('RejectedByUser').status, 'rejected');
  assert.deepEqual(parseStatus('Something Else').status, 'other');
  assert.deepEqual(splitYearSuffix('UNKNOWN, CLIENT 07 2025'), { name: 'UNKNOWN, CLIENT 07', year: 2025 });
  assert.deepEqual(splitYearSuffix('SYNTHETIC COMMUNITY NFP'), { name: 'SYNTHETIC COMMUNITY NFP', year: null });
  assert.equal(formFamily('CA 540NR', 'CA').family, '1040');
  assert.equal(formFamily('WI 1', 'WI').family, '1040');
  assert.equal(formFamily('990EZ', null).family, '990ez');
  assert.equal(formFamily('IL 1065', 'IL').family, '1065');
  assert.deepEqual(formFamily('8868', null), { family: '990', extensionForm: '8868' });
  assert.equal(formFamily('XX 999Z', 'XX').family, null, 'a form this table does not know is not guessed');
  assert.equal(chicagoToUtcIso(2026, 3, 8, 2, 30, 0), '2026-03-08T07:30:00.000Z', 'the spring-forward hour resolves to an instant without throwing');
  assert.deepEqual(parseStatusDate('4/15/2026'), { acknowledgedOn: '2026-04-15', statusAt: '2026-04-15T05:00:00.000Z' });
  assert.equal(maskIdentifiers("'900001234,x,900005678,2319480000001193myk83"), "*****1234,x,*****5678,2319480000001193myk83", 'standalone nine-digit runs only; the E-file ID is left alone');
});

test('one accepted, one rejected, one unmatched → one queued send, one task (the rejection matched), the unmatched row raises nothing', async () => {
  await arm(false);
  const ok = await filedReturn('Accepted', 'Client');
  const rej = await filedReturn('Rejected', 'Client');
  const report = atxReport([
    atxRow({ name: ok.exportName, last4: ok.ssnLast4, jurisdiction: 'Federal', type: '1040', status: 'Accepted', when: '9/11/2026 3:00:00 PM' }),
    atxRow({ name: rej.exportName, last4: rej.ssnLast4, jurisdiction: 'Federal', type: '1040', status: 'RejectedByAgency', when: '9/11/2026 3:01:00 PM' }),
    atxRow({ name: 'NOBODY, HERE 2025', last4: '9876', jurisdiction: 'Federal', type: '1040', status: 'Accepted', when: '9/11/2026 3:02:00 PM' }),
  ]);
  const r = await ingestReport(app, actor(), { filename: 'ack.csv', text: report, today: '2026-09-11' });
  assert.equal(r.rows, 3);
  assert.equal(r.queued, 1, 'exactly one send queued');
  assert.equal(r.tasks, 1, 'the rejection is a task; the unmatched row is not');
  assert.equal(r.unmatched, 1, 'and it is counted');
  assert.equal(sent.length, 0, 'nothing sent on upload');

  const rows = await ackRows(r.reportId);
  assert.deepEqual(rows.map((x) => x.disposition), ['queued', 'task', 'unmatched']);
  assert.equal(rows[0]!.tax_engagement_id, ok.taxEngagementId);
  assert.equal(rows[0]!.tax_year, 2025, 'the tax year comes from the matched SAOS return, not the export');
  assert.equal(rows[0]!.taxpayer_last4, ok.ssnLast4, 'the last four is kept');
  assert.equal(rows[2]!.tax_engagement_id, null, 'the unmatched row is matched to nothing — no guess');
  assert.equal(rows[2]!.task_id, null, 'and raises no task');
  assert.match(rows[2]!.disposition_note, /no SAOS return at filed awaits Federal/);
  assert.ok(rows[1]!.task_id, 'the rejection has its task');

  // The rejection took the existing owned path: perfection clock + efile_reject task, no email.
  const te = await app.db.query<{ stage: string; perfection_deadline: string | null }>(
    `SELECT stage::text AS stage, perfection_deadline::text AS perfection_deadline FROM tax_engagements WHERE id = $1`, [rej.taxEngagementId]);
  assert.equal(te.rows[0]!.stage, 'rejected');
  assert.ok(te.rows[0]!.perfection_deadline);
  const task = await app.db.query<{ title: string; description: string; assigned_staff_id: string | null; source_type: string }>(`SELECT title, description, assigned_staff_id, source_type FROM tasks WHERE id = $1`, [rows[1]!.task_id]);
  assert.equal(task.rows[0]!.source_type, 'efile_reject');
  assert.equal(task.rows[0]!.assigned_staff_id, ana.id, 'owned by the return\'s preparer');
  assert.doesNotMatch(task.rows[0]!.title + task.rows[0]!.description, /CLIENT, REJECTED/, 'the task never carries the export\'s name field');
  assert.doesNotMatch(task.rows[0]!.title + task.rows[0]!.description, /\d{9}/, 'nor an identifier');
  // The accepted one records the date and completed.
  const okTe = await app.db.query<{ stage: string; federal_accepted_on: string | null }>(`SELECT stage::text AS stage, federal_accepted_on::text AS federal_accepted_on FROM tax_engagements WHERE id = $1`, [ok.taxEngagementId]);
  assert.equal(okTe.rows[0]!.stage, 'completed');
  assert.equal(okTe.rows[0]!.federal_accepted_on, '2026-09-11');

  // The stored file is masked; no full identifier anywhere the upload touched.
  const stored = await app.db.query<{ raw_text: string; holds: boolean }>(`SELECT raw_text, raw_text ~ '(?<![0-9A-Za-z])[0-9]{9}(?![0-9A-Za-z])' AS holds FROM efile_ack_reports WHERE id = $1`, [r.reportId]);
  assert.equal(stored.rows[0]!.holds, false, 'the raw file holds no nine-digit identifier');
  assert.match(stored.rows[0]!.raw_text, new RegExp(`\\*\\*\\*\\*\\*${ok.ssnLast4}`), 'it holds the last four');
  const anywhere = await app.db.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM efile_acknowledgments WHERE report_id = $1 AND concat_ws(' ', client_name_raw, disposition_note, status_raw, submission_id) ~ '(?<![0-9A-Za-z])[0-9]{9}(?![0-9A-Za-z])')
          + (SELECT count(*) FROM tasks WHERE source_id LIKE $1::text || ':%' AND concat_ws(' ', title, description) ~ '(?<![0-9A-Za-z])[0-9]{9}(?![0-9A-Za-z])')
          + (SELECT count(*) FROM audit_log WHERE object_id = $1::text AND details::text ~ '(?<![0-9A-Za-z])[0-9]{9}(?![0-9A-Za-z])') AS n`, [r.reportId]);
  assert.equal(anywhere.rows[0]!.n, '0');

  // Release with the gate OFF: recorded as held by the automation, nothing sent.
  const rel = await releaseReport(app, actor(), r.reportId);
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
  const es = await filedReturn('Federico', 'Estado', { language: 'es', jurisdictions: ['federal', 'IL'] });
  const report = atxReport([
    atxRow({ name: es.exportName, last4: es.ssnLast4, jurisdiction: 'Federal', type: '1040', status: 'Accepted', when: '9/12/2026 9:00:00 AM' }),
    atxRow({ name: es.exportName, last4: es.ssnLast4, jurisdiction: 'IL', type: 'IL 1040', status: 'AcceptedWithMessages', when: '9/12/2026 9:30:00 PM' }),
  ]);
  const r = await ingestReport(app, actor(), { filename: 'ack2.csv', text: report, today: '2026-09-12' });
  assert.equal(r.queued, 2, JSON.stringify(r));
  await releaseReport(app, actor(), r.reportId);
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
  const each = await app.db.query<{ jurisdiction: string; accepted_on: string | null }>(
    `SELECT jurisdiction, accepted_on::text AS accepted_on FROM tax_engagement_jurisdictions
      WHERE tax_engagement_id = $1 ORDER BY (jurisdiction <> 'federal'), jurisdiction`, [es.taxEngagementId]);
  assert.deepEqual(each.rows, [{ jurisdiction: 'federal', accepted_on: '2026-09-12' }, { jurisdiction: 'IL', accepted_on: '2026-09-12' }]);
  assert.equal((await app.db.query<{ stage: string }>(`SELECT stage::text AS stage FROM tax_engagements WHERE id = $1`, [es.taxEngagementId])).rows[0]!.stage, 'completed');
  const flagged = await app.db.query<{ accepted_with_messages: boolean }>(`SELECT accepted_with_messages FROM efile_acknowledgments WHERE report_id = $1 AND row_index = 2`, [r.reportId]);
  assert.equal(flagged.rows[0]!.accepted_with_messages, true, 'AcceptedWithMessages counted as accepted and kept its flag');
});

test('a held row does not send when the report is released; the same file twice is the same report', async () => {
  await arm(true);
  sent.length = 0;
  const h = await filedReturn('Holding', 'Pattern');
  const report = atxReport([atxRow({ name: h.exportName, last4: h.ssnLast4, jurisdiction: 'Federal', type: '1040', status: 'Accepted' })]);
  const r = await ingestReport(app, actor(), { filename: 'ack3.csv', text: report });
  const row = await app.db.query<{ id: string }>(`SELECT id FROM efile_acknowledgments WHERE report_id = $1`, [r.reportId]);
  await holdRow(app, actor(), row.rows[0]!.id, true);
  const rel = await releaseReport(app, actor(), r.reportId);
  assert.equal(rel.enqueued, 0);
  assert.equal(rel.held, 1);
  await drainOutbox(app);
  if (sent.length !== 0) {
    // A one-off red here in a full run (2026-09-20) had no evidence behind it. The next one carries
    // what was sent and every outbox row, so the cause can be read instead of guessed.
    const rows = await app.db.query(`SELECT id, effect, status, attempts, created_at, next_attempt_at, last_error FROM outbox ORDER BY created_at`);
    console.error('[efile-ack held-row diagnostic] sent:', JSON.stringify(sent), 'outbox:', JSON.stringify(rows.rows));
  }
  assert.equal(sent.length, 0);

  const again = await ingestReport(app, actor(), { filename: 'ack3-copy.csv', text: report });
  assert.equal(again.alreadyIngested, true);
  assert.equal(again.reportId, r.reportId);
});

test('the identifier is the key: two same-named returns with the same last four are ambiguous (unmatched, no task); a different last four separates them', async () => {
  const a = await filedReturn('Twin', 'Name', { ssnLast4: '1111' });
  await filedReturn('Twin', 'Name', { ssnLast4: '1111' });
  const r = await ingestReport(app, actor(), { filename: 'ack4.csv', text: atxReport([atxRow({ name: a.exportName, last4: '1111', jurisdiction: 'Federal', type: '1040', status: 'Accepted' })]) });
  assert.equal(r.queued, 0);
  assert.equal(r.tasks, 0, 'ambiguity is not a task; it is an unmatched row a person can read');
  assert.equal(r.unmatched, 1);
  const rows = await ackRows(r.reportId);
  assert.match(rows[0]!.disposition_note, /2 SAOS returns fit this row/);

  const c = await filedReturn('Twin', 'Name', { ssnLast4: '2222' });
  const r2 = await ingestReport(app, actor(), { filename: 'ack4b.csv', text: atxReport([atxRow({ name: c.exportName, last4: '2222', jurisdiction: 'Federal', type: '1040', status: 'Accepted' })]) });
  assert.equal(r2.queued, 1);
  assert.equal((await ackRows(r2.reportId))[0]!.tax_engagement_id, c.taxEngagementId);
});

test('matched on the identifier but the name disagrees: held for review with a task, nothing applied; the unhold applies it and queues the notice', async () => {
  await arm(false);
  const t = await filedReturn('Real', 'Person', { ssnLast4: '3333' });
  const r = await ingestReport(app, actor(), { filename: 'ack5.csv', text: atxReport([
    atxRow({ name: 'SOMEONE, ELSE 2025', last4: '3333', jurisdiction: 'Federal', type: '1040', status: 'Accepted', when: '9/13/2026 1:00:00 PM' }),
  ]), today: '2026-09-13' });
  assert.equal(r.queued, 0);
  assert.equal(r.tasks, 1, 'a matched row that needs a person raises a task');
  const [row] = await ackRows(r.reportId);
  assert.equal(row!.disposition, 'held');
  assert.equal(row!.tax_engagement_id, t.taxEngagementId, 'matched on identifier, form and jurisdiction');
  assert.match(row!.disposition_note, /name does not agree/);
  const te = await app.db.query<{ stage: string; federal_accepted_on: string | null }>(`SELECT stage::text AS stage, federal_accepted_on::text AS federal_accepted_on FROM tax_engagements WHERE id = $1`, [t.taxEngagementId]);
  assert.equal(te.rows[0]!.stage, 'filed', 'nothing applied');
  assert.equal(te.rows[0]!.federal_accepted_on, null);
  const task = await app.db.query<{ title: string; description: string; assigned_staff_id: string }>(`SELECT title, description, assigned_staff_id FROM tasks WHERE id = $1`, [row!.task_id]);
  assert.match(task.rows[0]!.title, /held for review: Federal on 1040 2025 for Real Person/, 'the return by form and year, the client by the SAOS contact');
  assert.doesNotMatch(task.rows[0]!.title + task.rows[0]!.description, /SOMEONE|ELSE/, 'never the export\'s name');
  assert.equal(task.rows[0]!.assigned_staff_id, ana.id);

  // Release skips the held row; the preparer unholds it: applied now, and queued.
  assert.equal((await releaseReport(app, actor(), r.reportId)).enqueued, 0);
  const ackId = (await app.db.query<{ id: string }>(`SELECT id FROM efile_acknowledgments WHERE report_id = $1`, [r.reportId])).rows[0]!.id;
  await holdRow(app, actor(), ackId, false, '2026-09-13');
  const after = await app.db.query<{ stage: string; federal_accepted_on: string | null }>(`SELECT stage::text AS stage, federal_accepted_on::text AS federal_accepted_on FROM tax_engagements WHERE id = $1`, [t.taxEngagementId]);
  assert.equal(after.rows[0]!.stage, 'completed', 'the unhold applied the acceptance');
  assert.equal(after.rows[0]!.federal_accepted_on, '2026-09-13');
  assert.equal((await ackRows(r.reportId))[0]!.disposition, 'queued');
  const audit = await app.db.query<{ details: { applied_on_unhold: boolean } }>(`SELECT details FROM audit_log WHERE action = 'efile_ack.row_released' AND object_id = $1`, [ackId]);
  assert.equal(audit.rows[0]!.details.applied_on_unhold, true);
});

test('the withdraw door: the report is void, its release is refused, its send retires, and the same file can be uploaded again', async () => {
  await arm(true);
  sent.length = 0;
  const w = await filedReturn('With', 'Drawn');
  const report = atxReport([atxRow({ name: w.exportName, last4: w.ssnLast4, jurisdiction: 'Federal', type: '1040', status: 'Accepted' })]);
  const r = await ingestReport(app, actor(), { filename: 'ack6.csv', text: report });
  assert.equal(r.queued, 1);
  await assert.rejects(() => withdrawReport(app, actor(), r.reportId, '   '), /Say why/);
  const out = await withdrawReport(app, { id: null, label: 'r43 cleanup script' }, r.reportId, 'Raised in error by an acknowledgment parser that could not read the ATX export. No action is needed.');
  assert.equal(out.queuedVoided, 1);
  await assert.rejects(() => releaseReport(app, actor(), r.reportId), /withdrawn/);
  await assert.rejects(() => withdrawReport(app, actor(), r.reportId, 'twice'), /already withdrawn/);
  const audit = await app.db.query<{ actor_type: string; actor_id: string | null; details: { reason: string } }>(
    `SELECT actor_type::text AS actor_type, actor_id, details FROM audit_log WHERE action = 'efile_ack.report_withdrawn' AND object_id = $1`, [r.reportId]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.actor_type, 'system', 'a script acting for the system is the system');
  assert.equal(audit.rows[0]!.actor_id, null);
  assert.match(audit.rows[0]!.details.reason, /Raised in error/);

  // The same file is a new report now: the withdrawn one no longer holds its hash.
  const again = await ingestReport(app, actor(), { filename: 'ack6-again.csv', text: report });
  assert.equal(again.alreadyIngested, false);
  assert.notEqual(again.reportId, r.reportId);
  assert.equal(again.duplicates, 1, 'the acceptance the first upload stamped is a fact: the re-upload reads it as already recorded');
  await drainOutbox(app);
  assert.equal(sent.length, 0, 'nothing from the withdrawn report, nothing from the duplicate');
});

test('the purge door: a report persisted the way the 2026-09-20 parser did is rewritten to last four everywhere, and the counts are audited', async () => {
  // The old parser stored the file verbatim and could put anything in a task; stage that record by hand, then purge it through the door.
  const p = await filedReturn('Pur', 'Ged');
  const report = atxReport([atxRow({ name: p.exportName, last4: p.ssnLast4, jurisdiction: 'Federal', type: '1040', status: 'Created' })]);
  const r = await ingestReport(app, actor(), { filename: 'E-Files.csv', text: report });
  await app.db.query(`UPDATE efile_ack_reports SET raw_text = $2 WHERE id = $1`, [r.reportId, report]);
  await app.db.query(`UPDATE efile_acknowledgments SET disposition_note = disposition_note || ' id 900001234' WHERE report_id = $1`, [r.reportId]);
  const task = await createTask(app, {
    title: 'E-file acknowledgment could not be applied: 900005678', description: "ATX report row 1: 900005678 and '900001234",
    source: 'automation', sourceType: 'efile_ack_review', sourceId: `${r.reportId}:1`, priority: 1,
  });
  const before = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM efile_ack_reports WHERE id = $1 AND raw_text ~ '(?<![0-9A-Za-z])[0-9]{9}(?![0-9A-Za-z])'`, [r.reportId]);
  assert.equal(before.rows[0]!.n, '1', 'the staged record holds a full identifier');

  const out = await purgeReportIdentifiers(app, { id: null, label: 'r43 cleanup script' }, r.reportId);
  assert.deepEqual(out, { rawFileIdentifiers: 1, ackRowsRewritten: 1, tasksRewritten: 1, auditRowsHoldingIdentifiers: 0 });
  const after = await app.db.query<{ raw: string; note: string; title: string; description: string }>(
    `SELECT r.raw_text AS raw, a.disposition_note AS note, t.title, t.description
       FROM efile_ack_reports r JOIN efile_acknowledgments a ON a.report_id = r.id JOIN tasks t ON t.id = $2 WHERE r.id = $1`, [r.reportId, task.id]);
  for (const v of Object.values(after.rows[0]!)) assert.doesNotMatch(v, /(?<![0-9A-Za-z])[0-9]{9}(?![0-9A-Za-z])/, 'no nine-digit run survives');
  assert.match(after.rows[0]!.note, /\*\*\*\*\*1234/);
  assert.match(after.rows[0]!.title, /\*\*\*\*\*5678/);
  assert.match(after.rows[0]!.description, /\*\*\*\*\*5678 and \*\*\*\*\*1234/);
  const twice = await purgeReportIdentifiers(app, actor(), r.reportId);
  assert.deepEqual(twice, { rawFileIdentifiers: 0, ackRowsRewritten: 0, tasksRewritten: 0, auditRowsHoldingIdentifiers: 0 }, 'idempotent');
  const audit = await app.db.query<{ details: Record<string, number> }>(`SELECT details FROM audit_log WHERE action = 'efile_ack.identifiers_purged' AND object_id = $1 ORDER BY occurred_at`, [r.reportId]);
  assert.equal(audit.rows.length, 2);
  assert.equal(audit.rows[0]!.details['raw_file_identifiers_masked'], 1);
  assert.equal(audit.rows[0]!.details['tasks_rewritten'], 1);
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
