/*
 * THE COMMITTED ATX FIXTURE THROUGH THE UPLOAD ROUTE (R43, 2026-09-26). Brian's expected result:
 * the two SYNTHETIC SCORP LLC rows complete a fixture return declared Federal plus IL; the twelve
 * UNKNOWN rows produce nothing — and so does every other row that belongs to a return SAOS does not
 * track. Then the rest of the ruling on the same file, with returns that DO exist: a pending row on a
 * matched return is no action; a rejected row on a matched return is the owned re-file task; a 4868
 * row on a not-yet-filed 1040 proposes the extension record and the preparer records it from the
 * screen; an 8868 row proposes one on a 990. Nothing persists a full identifier. Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, multipartBody, signed8879OnFile, type TestStaff } from './helpers.ts';
import { atxFixture } from './atx.ts';
import type { Config } from '../src/config.ts';
import type { Mailer } from '../src/mailer.ts';
import { IDENTIFIER_SQL } from '../src/modules/tax/efile-ack.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role} ${email.split('@')[0]}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('efile_ack_atx');
  const mailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  brian = await staffWithToken('brian-atx@example.test', 'ceo');
  ana = await staffWithToken('ana-atx@example.test', 'tax_preparer');
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'efile_acknowledgment'`);
});
after(async () => { await app.close(); });

/** A business return through the doors: the business, the return, the signed 8879, then the filing transition with its declared list. */
async function filedBusinessReturn(o: { last: string; entity: string; ein: string; returnType: string; taxYear: number; jurisdictions: string[]; entityType?: string }) {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: o.last, email: `${o.last.toLowerCase()}-atx@example.test` });
  const biz = await app.inject({ method: 'POST', url: `/contacts/${c.id}/businesses`, headers: auth(brian), payload: { name: o.entity, ein: o.ein, entityType: o.entityType ?? 's_corp', state: 'IL' } });
  assert.equal(biz.statusCode, 201, biz.body);
  const created = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(ana), payload: {
    reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows',
    contactId: c.id, businessId: biz.json().id as string, taxYear: o.taxYear, returnType: o.returnType, clientType: 'business', preparerId: ana.id,
  } });
  assert.equal(created.statusCode, 201, created.body);
  const teId = created.json().id as string;
  await signed8879OnFile(app, teId, ana.id, `${o.taxYear + 1}-02-01`);
  await app.db.query(`UPDATE tax_engagements SET stage = 'ready_to_file', engagement_letter_signed_at = now(), estimate_locked_at = now() WHERE id = $1`, [teId]);
  const filed = await app.inject({ method: 'POST', url: `/tax-engagements/${teId}/transition`, headers: auth(ana),
    payload: { toStage: 'filed', preparerPtinHolderId: ana.id, jurisdictions: o.jurisdictions } });
  assert.equal(filed.statusCode, 200, filed.body);
  return { contactId: c.id, teId };
}

/** An individual return at the given stage, with the SSN last four the fixture row carries. */
async function individualReturn(o: { first: string; last: string; ssnLast4: string; stage: 'filed' | 'in_preparation'; taxYear?: number; returnType?: string }) {
  const c = await makeContact(app.db, { firstName: o.first, lastName: o.last, email: `${o.first}.${o.last}-atx@example.test`.toLowerCase() });
  await app.db.query(`UPDATE contacts SET ssn_last4 = $2 WHERE id = $1`, [c.id, o.ssnLast4]);
  const eng = await app.db.query<{ id: string }>(`INSERT INTO engagements (contact_id, service_line, title, status) VALUES ($1, 'tax', 'return', 'active') RETURNING id`, [c.id]);
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, preparer_id, engagement_letter_signed_at, estimate_locked_at)
     VALUES ($1, $2, $3::return_type, 'ready_to_file', $4, now(), now()) RETURNING id`, [eng.rows[0]!.id, o.taxYear ?? 2025, o.returnType ?? '1040', ana.id]);
  const teId = te.rows[0]!.id;
  if (o.stage === 'filed') {
    await signed8879OnFile(app, teId, ana.id);
    const filed = await app.inject({ method: 'POST', url: `/tax-engagements/${teId}/transition`, headers: auth(ana), payload: { toStage: 'filed', preparerPtinHolderId: ana.id, jurisdictions: ['federal'] } });
    assert.equal(filed.statusCode, 200, filed.body);
  } else {
    await app.db.query(`UPDATE tax_engagements SET stage = $2 WHERE id = $1`, [teId, o.stage]);
  }
  return { contactId: c.id, teId };
}

async function upload(filename: string, text: string, asOf = '2026-09-26') {
  const mp = multipartBody({}, { field: 'file', filename, contentType: 'text/csv', data: Buffer.from(text, 'utf8') });
  const res = await app.inject({ method: 'POST', url: `/efile-acks?asOf=${asOf}`, headers: { ...auth(ana), ...mp.headers }, payload: mp.payload });
  return res;
}

async function returnState(teId: string) {
  const { rows } = await app.db.query<{ stage: string; federal_accepted_on: string | null; state_accepted_on: string | null; state_accepted_code: string | null; extension_filed: boolean; extension_form: string | null; extension_filed_date: string | null }>(
    `SELECT stage::text AS stage, federal_accepted_on::text AS federal_accepted_on, state_accepted_on::text AS state_accepted_on, state_accepted_code,
            extension_filed, extension_form, extension_filed_date::text AS extension_filed_date FROM tax_engagements WHERE id = $1`, [teId]);
  return rows[0]!;
}

test('the fixture: the two SYNTHETIC SCORP LLC rows complete a return declared Federal + IL; the twelve UNKNOWN rows and every other row produce nothing', async () => {
  const scorp = await filedBusinessReturn({ last: 'Scorp', entity: 'Synthetic Scorp, LLC', ein: '90-0000054', returnType: '1120s', taxYear: 2025, jurisdictions: ['federal', 'IL'] });
  const res = await upload('ATX_EFiles_synthetic.csv', atxFixture());
  assert.equal(res.statusCode, 201, res.body);
  const r = res.json() as { reportId: string; rows: number; queued: number; tasks: number; duplicates: number; unmatched: number; pending: number; extensions: number; skipped: unknown[] };
  assert.equal(r.rows, 34, 'every row of the fixture parsed');
  assert.equal(r.queued, 2, 'the two S corp rows will send');
  assert.equal(r.tasks, 0, 'no task: nothing else matched, and an unmatched row is never a task');
  assert.equal(r.unmatched, 32, 'thirty-two rows belong to returns SAOS does not track');
  assert.equal(r.pending, 0);
  assert.equal(r.extensions, 0);
  assert.equal(r.duplicates, 0);
  assert.deepEqual(r.skipped, []);

  const s = await returnState(scorp.teId);
  assert.equal(s.stage, 'completed', 'federal and Illinois both accepted complete the return');
  assert.equal(s.federal_accepted_on, '2026-09-15');
  assert.equal(s.state_accepted_on, '2026-09-15', '11:41 PM Central is still the 15th');
  assert.equal(s.state_accepted_code, 'IL');

  const rows = await app.db.query<{ row_index: number; client_name_raw: string; disposition: string; task_id: string | null; tax_engagement_id: string | null; taxpayer_last4: string; tax_year: number | null; accepted_with_messages: boolean; status_at: Date | null; status: string }>(
    `SELECT row_index, client_name_raw, disposition::text AS disposition, task_id, tax_engagement_id, taxpayer_last4, tax_year, accepted_with_messages, status_at, status::text AS status
       FROM efile_acknowledgments WHERE report_id = $1 ORDER BY row_index`, [r.reportId]);
  assert.equal(rows.rows.length, 34);
  const scorpRows = rows.rows.filter((x) => x.client_name_raw === 'SYNTHETIC SCORP LLC');
  assert.equal(scorpRows.length, 2);
  for (const x of scorpRows) {
    assert.equal(x.disposition, 'queued');
    assert.equal(x.tax_engagement_id, scorp.teId);
    assert.equal(x.tax_year, 2025, 'the tax year is the SAOS return\'s: the export has none');
    assert.equal(x.taxpayer_last4, '0054');
  }
  assert.equal(scorpRows[1]!.accepted_with_messages, true, 'the Illinois row was AcceptedWithMessages: accepted, flagged');
  assert.equal(scorpRows[0]!.status_at!.toISOString(), '2026-09-15T23:41:08.000Z', 'Central read as Central');
  const unknown = rows.rows.filter((x) => x.client_name_raw.startsWith('UNKNOWN, CLIENT'));
  assert.equal(unknown.length, 12);
  for (const x of unknown) {
    assert.equal(x.disposition, 'unmatched');
    assert.equal(x.task_id, null);
    assert.equal(x.tax_engagement_id, null);
  }
  for (const x of rows.rows.filter((x) => x.client_name_raw !== 'SYNTHETIC SCORP LLC')) {
    assert.equal(x.disposition, 'unmatched', `row ${x.row_index} (${x.status}) belongs to nobody SAOS tracks`);
    assert.equal(x.task_id, null, `row ${x.row_index} raised no task`);
  }
  const tasks = await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM tasks WHERE source_type IN ('efile_ack_review', 'efile_reject') AND created_at > now() - interval '1 minute'`);
  assert.equal(tasks.rows[0]!.n, '0', 'no task anywhere from this upload');

  // The persistence rule, checked over everything the upload touched.
  const held = await app.db.query<{ report: string; acks: string; tasks: string; audit: string; raw_len: number; raw_masked: number }>(
    `SELECT (SELECT count(*) FROM efile_ack_reports WHERE id = $1 AND raw_text ~ $2)::text AS report,
            (SELECT count(*) FROM efile_acknowledgments WHERE report_id = $1 AND concat_ws(' ', client_name_raw, disposition_note, status_raw, submission_id) ~ $2)::text AS acks,
            (SELECT count(*) FROM tasks WHERE source_id LIKE $1::text || ':%' AND concat_ws(' ', title, description) ~ $2)::text AS tasks,
            (SELECT count(*) FROM audit_log WHERE object_id = $1::text AND details::text ~ $2)::text AS audit,
            (SELECT length(raw_text) FROM efile_ack_reports WHERE id = $1) AS raw_len,
            (SELECT (length(raw_text) - length(replace(raw_text, '*****', ''))) / 5 FROM efile_ack_reports WHERE id = $1) AS raw_masked`,
    [r.reportId, IDENTIFIER_SQL]);
  assert.deepEqual([held.rows[0]!.report, held.rows[0]!.acks, held.rows[0]!.tasks, held.rows[0]!.audit], ['0', '0', '0', '0'], 'no full identifier anywhere');
  assert.equal(held.rows[0]!.raw_masked, 34, 'the stored file carries thirty-four masked identifiers, one per row');
  assert.ok(held.rows[0]!.raw_len > 1000, 'and is otherwise the file');

  // The review screen's read: the report carries the counts and no identifier claim.
  const view = await app.inject({ method: 'GET', url: `/efile-acks/${r.reportId}`, headers: auth(ana) });
  assert.equal(view.statusCode, 200);
  const rep = view.json().report as { unmatched_count: number; matched_count: number; task_count: number; holds_identifiers: boolean; withdrawn_at: string | null };
  assert.equal(rep.unmatched_count, 32);
  assert.equal(rep.matched_count, 2);
  assert.equal(rep.task_count, 0);
  assert.equal(rep.holds_identifiers, false);
  assert.equal(rep.withdrawn_at, null);
  assert.doesNotMatch(view.body, /900000054|90000000[0-9]/, 'the screen is never handed a full identifier');

  // Release: only the two matched accepted rows go to the outbox.
  const rel = await app.inject({ method: 'POST', url: `/efile-acks/${r.reportId}/release`, headers: auth(ana) });
  assert.equal(rel.statusCode, 200, rel.body);
  assert.equal(rel.json().enqueued, 2);
});

test('the same fixture with returns that exist: a pending row is no action, a rejection is the owned re-file task, extension rows propose R12 records and the preparer records one', async () => {
  // PERSON E: filed 1040, federal Created → pending, matched, no task. PERSON B: filed 1040, RejectedByAgency → re-file task.
  const e = await individualReturn({ first: 'Person E', last: 'Synthetic', ssnLast4: '0005', stage: 'filed' });
  const b = await individualReturn({ first: 'Person B', last: 'Synthetic', ssnLast4: '0002', stage: 'filed' });
  // PERSON H: 1040 in preparation, a 4868 accepted 4/15 → proposed. The NFP: a 990 in preparation, an 8868 accepted → proposed.
  const h = await individualReturn({ first: 'Person H', last: 'Synthetic', ssnLast4: '0008', stage: 'in_preparation' });
  const nfp = await (async () => {
    const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Nfpowner', email: 'nfp-atx@example.test' });
    const biz = await app.inject({ method: 'POST', url: `/contacts/${c.id}/businesses`, headers: auth(brian), payload: { name: 'Synthetic Community NFP', ein: '90-0000062', entityType: 'nonprofit', state: 'IL' } });
    assert.equal(biz.statusCode, 201, biz.body);
    const created = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(ana), payload: {
      reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows',
      contactId: c.id, businessId: biz.json().id as string, taxYear: 2025, returnType: '990', clientType: 'business', preparerId: ana.id,
    } });
    assert.equal(created.statusCode, 201, created.body);
    const teId = created.json().id as string;
    await app.db.query(`UPDATE tax_engagements SET stage = 'in_preparation' WHERE id = $1`, [teId]);
    return { teId };
  })();

  // A byte of the file changed (a trailing newline) so the upload is a new report and not the first test's.
  const res = await upload('ATX_EFiles_synthetic-2.csv', `${atxFixture()}\n`);
  assert.equal(res.statusCode, 201, res.body);
  const r = res.json() as { reportId: string; queued: number; tasks: number; unmatched: number; pending: number; extensions: number; duplicates: number };
  assert.equal(r.pending, 1, 'PERSON E: Created at ATX, matched, no action');
  assert.equal(r.tasks, 2, 'PERSON B: rejected, matched, the re-file task; UNKNOWN 05: the last-four collision held for a person');
  assert.equal(r.extensions, 2, 'the 4868 and the 8868 propose records; the 7004 has no SAOS return');
  assert.equal(r.queued, 0, 'the S corp return completed in the first test: its rows read as already recorded');
  assert.equal(r.duplicates, 2);
  assert.equal(r.unmatched, 34 - 1 - 2 - 2 - 2, 'everything else');

  const rows = await app.db.query<{ client_name_raw: string; disposition: string; task_id: string | null; tax_engagement_id: string | null; extension_form: string | null; acknowledged_on: string | null; disposition_note: string; id: string }>(
    `SELECT id, client_name_raw, disposition::text AS disposition, task_id, tax_engagement_id, extension_form, acknowledged_on::text AS acknowledged_on, disposition_note
       FROM efile_acknowledgments WHERE report_id = $1 ORDER BY row_index`, [r.reportId]);
  const byName = (n: string) => rows.rows.filter((x) => x.client_name_raw === n);

  const pending = byName('SYNTHETIC, PERSON E 2025')[0]!;
  assert.equal(pending.disposition, 'pending');
  assert.equal(pending.tax_engagement_id, e.teId);
  assert.equal(pending.task_id, null);
  assert.equal((await returnState(e.teId)).stage, 'filed', 'nothing changed on a pending row');
  // UNKNOWN, CLIENT 05 shares the last four with PERSON E and is Accepted: matched on the identifier, but the name disagrees → held with a task, nothing applied.
  const collide = byName('UNKNOWN, CLIENT 05 2025')[0]!;
  assert.equal(collide.disposition, 'held', 'a last-four collision with a different name is held for a person, not applied');
  assert.ok(collide.task_id);
  assert.equal((await returnState(e.teId)).federal_accepted_on, null, 'and it stamped nothing');

  const rejected = byName('SYNTHETIC, PERSON B 2025')[0]!;
  assert.equal(rejected.disposition, 'task');
  assert.equal(rejected.tax_engagement_id, b.teId);
  assert.equal((await returnState(b.teId)).stage, 'rejected');
  const task = await app.db.query<{ source_type: string; title: string; description: string; assigned_staff_id: string }>(`SELECT source_type, title, description, assigned_staff_id FROM tasks WHERE id = $1`, [rejected.task_id]);
  assert.equal(task.rows[0]!.source_type, 'efile_reject');
  assert.equal(task.rows[0]!.assigned_staff_id, ana.id, 'owned by the return\'s preparer');
  assert.doesNotMatch(task.rows[0]!.title + task.rows[0]!.description, /SYNTHETIC, PERSON|\d{9}/, 'the task carries neither the export\'s name nor an identifier');

  const ext4868 = byName('SYNTHETIC, PERSON H 2025')[0]!;
  assert.equal(ext4868.disposition, 'extension_proposed');
  assert.equal(ext4868.tax_engagement_id, h.teId);
  assert.equal(ext4868.extension_form, '4868');
  assert.equal(ext4868.acknowledged_on, '2026-04-15');
  assert.equal(ext4868.task_id, null, 'a proposal is not a task');
  assert.equal((await returnState(h.teId)).extension_filed, false, 'proposed, not recorded');
  const ext8868 = byName('SYNTHETIC COMMUNITY NFP').find((x) => x.extension_form === '8868')!;
  assert.equal(ext8868.disposition, 'extension_proposed');
  assert.equal(ext8868.tax_engagement_id, nfp.teId);
  const ext7004 = byName('SYNTHETIC PARTNERS LLC').find((x) => x.extension_form === '7004')!;
  assert.equal(ext7004.disposition, 'unmatched', 'no SAOS partnership return: listed only');

  // The preparer records the 4868 from the screen: the R12 door, form and date from the row, no email.
  const recorded = await app.inject({ method: 'POST', url: `/efile-acks/rows/${ext4868.id}/record-extension?asOf=2026-09-26`, headers: auth(ana) });
  assert.equal(recorded.statusCode, 200, recorded.body);
  assert.equal(recorded.json().form, '4868');
  assert.equal(recorded.json().filedOn, '2026-04-15');
  const hs = await returnState(h.teId);
  assert.equal(hs.extension_filed, true);
  assert.equal(hs.extension_form, '4868');
  assert.equal(hs.extension_filed_date, '2026-04-15');
  const again = await app.inject({ method: 'POST', url: `/efile-acks/rows/${ext4868.id}/record-extension?asOf=2026-09-26`, headers: auth(ana) });
  assert.equal(again.statusCode, 409, 'recorded once');
  // The filing transitions in the fixture set-up enqueue their own invoice sends; the ack module enqueued nothing.
  const outbox = await app.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM outbox o JOIN efile_acknowledgments a ON a.id::text = o.payload->>'ackId' WHERE a.report_id = $1`, [r.reportId]);
  assert.equal(outbox.rows[0]!.n, '0', 'no acknowledgment email from any of it');

  // Withdraw through the route: the reason is required, the report reads withdrawn, its release is refused.
  const noReason = await app.inject({ method: 'POST', url: `/efile-acks/${r.reportId}/withdraw`, headers: auth(ana), payload: {} });
  assert.equal(noReason.statusCode, 400, noReason.body);
  const withdrawn = await app.inject({ method: 'POST', url: `/efile-acks/${r.reportId}/withdraw`, headers: auth(ana), payload: { reason: 'Uploaded twice while rehearsing.' } });
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  const list = (await app.inject({ method: 'GET', url: '/efile-acks', headers: auth(ana) })).json().reports as Array<{ id: string; withdrawn_at: string | null; withdrawn_reason: string | null }>;
  assert.match(list.find((x) => x.id === r.reportId)!.withdrawn_reason!, /rehearsing/);
  const rel = await app.inject({ method: 'POST', url: `/efile-acks/${r.reportId}/release`, headers: auth(ana) });
  assert.equal(rel.statusCode, 409);
  assert.equal(rel.json().error, 'report_withdrawn');
});
