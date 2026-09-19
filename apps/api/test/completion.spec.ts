/*
 * COMPLETION IS EVERY JURISDICTION (Brian, 2026-09-19, item 4):
 *   - a return completes when every jurisdiction it files in has accepted, not on federal alone;
 *     federal-then-state and state-then-federal both complete on the SECOND acknowledgment;
 *   - a return with no state (contact state null, no business) completes on federal, as before;
 *   - a state row for some other state is recorded but does not count, and the note says so;
 *   - a rejection from either jurisdiction raises the preparer's re-file task through createTask,
 *     owned by the return's preparer, else the role holder, else the CEO (recorded as unfilled);
 *   - a completed engagement with a sent invoice reports open_balance_cents on GET /engagements
 *     and is counted in completedUnpaid on the executive dashboard.
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, signed8879OnFile, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import type { Mailer } from '../src/mailer.ts';
import { ingestReport } from '../src/modules/tax/efile-ack.ts';
import { jurisdictionsAwaiting } from '../src/modules/tax/pipeline.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const actor = () => ({ id: brian.id, label: brian.fullName });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role} ${email.split('@')[0]}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('completion');
  const mailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  brian = await staffWithToken('brian-completion@example.test', 'ceo');
  ana = await staffWithToken('ana-completion@example.test', 'tax_preparer');
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'efile_acknowledgment'`);
});
after(async () => { await app.close(); });

const BIZ_HEADER = 'Entity Name,EIN,Tax Year,Return Type,Agency,Status,Submission ID,Ack Date,Reject Code,Reject Reason';
const IND_HEADER = 'Client Name,Tax Year,Return Type,Agency,Status,Submission ID,Ack Date,Reject Code,Reject Reason';
let seq = 0;

/** A filed 1120S on its own client and Illinois business (businesses.state = IL), with the preparer given. */
async function filedBusinessReturn(last: string, preparerId: string | null): Promise<{ contactId: string; teId: string; engagementId: string; entity: string }> {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: last, email: `${last.toLowerCase()}-completion@example.test` });
  const entity = `Synthetic ${last}, LLC`;
  const biz = await app.inject({ method: 'POST', url: `/contacts/${c.id}/businesses`, headers: auth(brian), payload: { name: entity, ein: '55-5555555', entityType: 's_corp', state: 'IL' } });
  assert.equal(biz.statusCode, 201, biz.body);
  const te = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(ana), payload: {
    reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows',
    contactId: c.id, businessId: biz.json().id as string, taxYear: 2025, returnType: '1120s', clientType: 'business', ...(preparerId ? { preparerId } : {}),
  } });
  assert.equal(te.statusCode, 201, te.body);
  const teId = te.json().id as string;
  await signed8879OnFile(app, teId, ana.id);
  await app.db.query(
    `UPDATE tax_engagements SET stage = 'filed', engagement_letter_signed_at = now(), estimate_locked_at = now(), preparer_id = $2,
            preparer_ptin_holder_id = COALESCE(preparer_ptin_holder_id, $3) WHERE id = $1`,
    [teId, preparerId, ana.id]);
  return { contactId: c.id, teId, engagementId: te.json().engagementId as string, entity };
}

/** A filed 1040 on a contact with no state: federal is the only jurisdiction. */
async function filedIndividualReturn(first: string, last: string): Promise<{ contactId: string; teId: string; engagementId: string }> {
  const c = await makeContact(app.db, { firstName: first, lastName: last, email: `${first}.${last}-completion@example.test`.toLowerCase() });
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status) VALUES ($1, 'tax', '2025 return', 'active') RETURNING id`, [c.id]);
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, preparer_id, engagement_letter_signed_at, estimate_locked_at)
     VALUES ($1, 2025, '1040', 'filed', $2, now(), now()) RETURNING id`, [eng.rows[0]!.id, ana.id]);
  await signed8879OnFile(app, te.rows[0]!.id, ana.id);
  return { contactId: c.id, teId: te.rows[0]!.id, engagementId: eng.rows[0]!.id };
}

async function ingest(lines: string[]) {
  seq++;
  return ingestReport(app, actor(), { filename: `report-${seq}.csv`, text: lines.join('\n'), today: '2026-09-19' });
}
const bizRow = (entity: string, agency: string, status: string, extra = ',,') => `"${entity}",5555,2025,1120S,${agency},${status},SUB-${++seq},09/19/2026${extra}`;

async function returnState(teId: string) {
  const { rows } = await app.db.query<{ stage: string; federal_accepted_on: string | null; state_accepted_on: string | null; state_accepted_code: string | null; efile_accepted_at: string | null; engagement_status: string }>(
    `SELECT te.stage::text AS stage, te.federal_accepted_on::text AS federal_accepted_on, te.state_accepted_on::text AS state_accepted_on, te.state_accepted_code,
            te.efile_accepted_at::text AS efile_accepted_at, e.status::text AS engagement_status
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE te.id = $1`, [teId]);
  return rows[0]!;
}
async function notesFor(reportId: string): Promise<Array<{ jurisdiction: string; state_code: string | null; disposition: string; note: string }>> {
  const { rows } = await app.db.query<{ jurisdiction: string; state_code: string | null; disposition: string; note: string }>(
    `SELECT jurisdiction::text AS jurisdiction, state_code, disposition::text AS disposition, disposition_note AS note FROM efile_acknowledgments WHERE report_id = $1 ORDER BY row_index`, [reportId]);
  return rows;
}

test('federal then state: the return completes on the state acknowledgment, not the federal one', async () => {
  const r = await filedBusinessReturn('Fedfirst', ana.id);
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), ['federal', 'IL']);

  const fed = await ingest([BIZ_HEADER, bizRow(r.entity, 'Federal', 'Accepted')]);
  assert.equal(fed.queued, 1, JSON.stringify(fed));
  let s = await returnState(r.teId);
  assert.equal(s.stage, 'filed', 'federal alone does not complete the return');
  assert.equal(s.federal_accepted_on, '2026-09-19', 'the federal date is stamped all the same');
  assert.equal(s.efile_accepted_at, null);
  assert.equal(s.engagement_status, 'active', 'the engagement stays open');
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), ['IL']);
  assert.match((await notesFor(fed.reportId))[0]!.note, /waits on IL/);
  const partial = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'tax_engagement.efile_accepted_partial' AND object_id = $1`, [r.teId]);
  assert.equal(partial.rows.length, 1, 'the partial acceptance is on the record');

  const il = await ingest([BIZ_HEADER, bizRow(r.entity, 'IL', 'Accepted')]);
  assert.equal(il.queued, 1, JSON.stringify(il));
  s = await returnState(r.teId);
  assert.equal(s.stage, 'completed', 'the second jurisdiction completes it');
  assert.equal(s.state_accepted_on, '2026-09-19');
  assert.equal(s.state_accepted_code, 'IL');
  assert.ok(s.efile_accepted_at, 'efile_accepted_at is the completion instant');
  assert.equal(s.engagement_status, 'completed', 'closeEngagementIfAllReturnsDone followed');
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), []);
  assert.match((await notesFor(il.reportId))[0]!.note, /the return is complete/);
});

test('state then federal: the order does not matter; the second acknowledgment completes', async () => {
  const r = await filedBusinessReturn('Statefirst', ana.id);
  const il = await ingest([BIZ_HEADER, bizRow(r.entity, 'IL', 'Accepted')]);
  assert.equal(il.queued, 1, JSON.stringify(il));
  let s = await returnState(r.teId);
  assert.equal(s.stage, 'filed', 'the state alone does not complete the return');
  assert.equal(s.state_accepted_code, 'IL');
  assert.equal(s.federal_accepted_on, null);
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), ['federal']);
  assert.match((await notesFor(il.reportId))[0]!.note, /waits on federal/);

  const fed = await ingest([BIZ_HEADER, bizRow(r.entity, 'Federal', 'Accepted')]);
  assert.equal(fed.queued, 1, JSON.stringify(fed));
  s = await returnState(r.teId);
  assert.equal(s.stage, 'completed');
  assert.equal(s.federal_accepted_on, '2026-09-19');
  assert.equal(s.engagement_status, 'completed');
});

test('a return with no state completes on federal alone, as before', async () => {
  const r = await filedIndividualReturn('Federal', 'Only');
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), ['federal']);
  const fed = await ingest([IND_HEADER, `"Only, Federal",2025,1040,Federal,Accepted,SUB-${++seq},09/19/2026,,`]);
  assert.equal(fed.queued, 1, JSON.stringify(fed));
  const s = await returnState(r.teId);
  assert.equal(s.stage, 'completed');
  assert.equal(s.federal_accepted_on, '2026-09-19');
  assert.equal(s.engagement_status, 'completed');
});

test('a state row for a different state is recorded but does not count; the right state still completes', async () => {
  const r = await filedBusinessReturn('Wrongstate', ana.id);
  const rep = await ingest([BIZ_HEADER, bizRow(r.entity, 'Federal', 'Accepted'), bizRow(r.entity, 'WI', 'Accepted')]);
  assert.equal(rep.queued, 2, JSON.stringify(rep));
  const notes = await notesFor(rep.reportId);
  assert.equal(notes[1]!.state_code, 'WI', 'the row is recorded as what it is');
  assert.equal(notes[1]!.disposition, 'queued');
  assert.match(notes[1]!.note, /accepted by WI, but this return files in IL/);
  assert.match(notes[1]!.note, /does not count/);
  let s = await returnState(r.teId);
  assert.equal(s.stage, 'filed', 'Wisconsin is not this return\'s state');
  assert.equal(s.state_accepted_code, null, 'and it is not stamped on the return');
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), ['IL']);

  await ingest([BIZ_HEADER, bizRow(r.entity, 'IL', 'Accepted')]);
  s = await returnState(r.teId);
  assert.equal(s.stage, 'completed');
  assert.equal(s.state_accepted_code, 'IL');
});

test('the manual door obeys the same rule: federal accepted leaves the return awaiting its state; the state completes it', async () => {
  const r = await filedBusinessReturn('Manualdoor', ana.id);
  const fed = await app.inject({ method: 'POST', url: `/tax-engagements/${r.teId}/efile-result`, headers: auth(ana), payload: { result: 'accepted', asOf: '2026-09-19' } });
  assert.equal(fed.statusCode, 200, fed.body);
  assert.equal(fed.json().stage, 'filed');
  assert.deepEqual(fed.json().awaiting, ['IL']);
  assert.equal((await returnState(r.teId)).federal_accepted_on, '2026-09-19', 'the manual acceptance is a dated fact on the row');
  const il = await app.inject({ method: 'POST', url: `/tax-engagements/${r.teId}/efile-result`, headers: auth(ana), payload: { result: 'accepted', jurisdiction: 'state', stateCode: 'IL', asOf: '2026-09-19' } });
  assert.equal(il.statusCode, 200, il.body);
  assert.equal(il.json().stage, 'completed');
  assert.equal((await returnState(r.teId)).engagement_status, 'completed');
});

test('a rejection from the state opens the preparer\'s re-file task through createTask, owned by the return\'s preparer', async () => {
  const r = await filedBusinessReturn('Statereject', ana.id);
  const rep = await ingest([BIZ_HEADER, bizRow(r.entity, 'IL', 'Rejected', ',IL-0042,Entity id does not match')]);
  assert.equal(rep.tasks, 1, JSON.stringify(rep));
  const s = await returnState(r.teId);
  assert.equal(s.stage, 'rejected');
  const task = await app.db.query<{ id: string; assigned_staff_id: string | null; source: string; source_type: string; title: string; description: string; priority: number; status: string }>(
    `SELECT id, assigned_staff_id, source::text AS source, source_type, title, description, priority, status::text AS status
       FROM tasks WHERE source_type = 'efile_reject' AND source_id = $1`, [r.teId]);
  assert.equal(task.rows.length, 1, 'one re-file task, through the one door');
  assert.equal(task.rows[0]!.assigned_staff_id, ana.id, 'owned by the return\'s preparer');
  assert.equal(task.rows[0]!.source, 'automation');
  assert.equal(task.rows[0]!.priority, 1);
  assert.equal(task.rows[0]!.status, 'not_started');
  assert.match(task.rows[0]!.title, /REJECTED by IL/);
  assert.match(task.rows[0]!.description, /IL-0042/);
  const ack = (await notesFor(rep.reportId))[0]!;
  assert.equal(ack.disposition, 'task');
  assert.match(ack.note, /rejected by IL/);
  const linked = await app.db.query<{ task_id: string | null }>(`SELECT task_id FROM efile_acknowledgments WHERE report_id = $1`, [rep.reportId]);
  assert.equal(linked.rows[0]!.task_id, task.rows[0]!.id, 'the acknowledgment row points at the task it raised');
  const alert = await app.db.query(`SELECT 1 FROM notifications WHERE type = 'efile_rejected' AND staff_id = $1 AND related_object_id = $2`, [ana.id, r.teId]);
  assert.equal(alert.rows.length, 1, 'and the owner is told');
});

test('a federal rejection on a return with no preparer falls back through the role: unfilled → the CEO, recorded', async () => {
  const r = await filedBusinessReturn('Nopreparer', null);
  // Nobody holds tax_preparer for the length of this test.
  await app.db.query(`UPDATE staff SET is_active = false WHERE id = $1`, [ana.id]);
  try {
    const rep = await ingest([BIZ_HEADER, bizRow(r.entity, 'Federal', 'Rejected', ',R0000-902,EIN already used')]);
    assert.equal(rep.tasks, 1, JSON.stringify(rep));
    const task = await app.db.query<{ assigned_staff_id: string | null; title: string }>(
      `SELECT assigned_staff_id, title FROM tasks WHERE source_type = 'efile_reject' AND source_id = $1`, [r.teId]);
    assert.equal(task.rows.length, 1);
    assert.equal(task.rows[0]!.assigned_staff_id, brian.id, 'the CEO owns it when the role is unfilled');
    assert.match(task.rows[0]!.title, /REJECTED by the IRS/);
    const unfilled = await app.db.query<{ details: { role: string; context: string; fell_back_to: string } }>(
      `SELECT details FROM audit_log WHERE action = 'staffing.role_unfilled' AND details->>'context' = 'efile_reject' ORDER BY occurred_at DESC LIMIT 1`);
    assert.equal(unfilled.rows.length, 1, 'the unfilled role is a recorded fact');
    assert.equal(unfilled.rows[0]!.details.role, 'tax_preparer');
    assert.equal(unfilled.rows[0]!.details.fell_back_to, 'ceo');
  } finally {
    await app.db.query(`UPDATE staff SET is_active = true WHERE id = $1`, [ana.id]);
  }
});

test('a completed engagement with a sent invoice shows its open balance on GET /engagements and counts on the executive dashboard', async () => {
  const r = await filedBusinessReturn('Stillowed', ana.id);
  const item = await app.db.query<{ amount_cents: number }>(`SELECT amount_cents FROM price_book_items WHERE is_active AND amount_cents > 0 ORDER BY amount_cents DESC LIMIT 1`);
  const total = Number(item.rows[0]!.amount_cents);
  await app.db.query(
    `INSERT INTO invoices (invoice_number, contact_id, engagement_id, status, subtotal_cents, total_cents, amount_paid_cents, sent_at)
     VALUES ($1, $2, $3, 'sent', $4, $4, 0, now())`,
    [`SYN-OWED-${seq}`, r.contactId, r.engagementId, total]);
  const rep = await ingest([BIZ_HEADER, bizRow(r.entity, 'Federal', 'Accepted'), bizRow(r.entity, 'IL', 'Accepted')]);
  assert.equal(rep.queued, 2, JSON.stringify(rep));
  const s = await returnState(r.teId);
  assert.equal(s.stage, 'completed');
  assert.equal(s.engagement_status, 'completed', 'the engagement completes with the invoice still open — the invoice is not what completion waits for');

  const list = await app.inject({ method: 'GET', url: `/engagements?contactId=${r.contactId}`, headers: auth(brian) });
  assert.equal(list.statusCode, 200, list.body);
  const row = (list.json().engagements as Array<{ id: string; status: string; open_balance_cents: number }>).find((e) => e.id === r.engagementId);
  assert.ok(row);
  assert.equal(row!.status, 'completed');
  assert.equal(row!.open_balance_cents, total, 'the open balance is on the engagement');

  const dash = await app.inject({ method: 'GET', url: '/dashboards/executive', headers: auth(brian) });
  assert.equal(dash.statusCode, 200, dash.body);
  assert.deepEqual(dash.json().completedUnpaid, { count: 1, balanceCents: total }, 'the one completed-and-unpaid engagement in this database');

  // Paid: it leaves the count and the balance.
  await app.db.query(`UPDATE invoices SET status = 'paid', amount_paid_cents = total_cents, paid_at = now() WHERE engagement_id = $1`, [r.engagementId]);
  const after = await app.inject({ method: 'GET', url: '/dashboards/executive', headers: auth(brian) });
  assert.deepEqual(after.json().completedUnpaid, { count: 0, balanceCents: 0 });
  const paidList = await app.inject({ method: 'GET', url: `/engagements?contactId=${r.contactId}`, headers: auth(brian) });
  assert.equal((paidList.json().engagements as Array<{ id: string; open_balance_cents: number }>).find((e) => e.id === r.engagementId)!.open_balance_cents, 0);
});
