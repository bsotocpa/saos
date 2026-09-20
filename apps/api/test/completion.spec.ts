/*
 * COMPLETION IS EVERY DECLARED JURISDICTION (Brian, 2026-09-19 item 4, and the evening's ruling 2:
 * the jurisdictions are DECLARED on the return, not guessed from an address):
 *   - a return completes when every jurisdiction it declares has accepted, not on federal alone;
 *     federal-then-state and state-then-federal both complete on the SECOND acknowledgment;
 *   - a return declared federal-only completes on federal;
 *   - a return declared federal + two states waits on both;
 *   - a return with no state (contact state null, no business) declares federal alone, as before;
 *   - a row for a state the return does not declare reads as needing review, opens an owned task
 *     through createTask, sends nothing and counts for nothing;
 *   - a rejection from either jurisdiction raises the preparer's re-file task through createTask,
 *     owned by the return's preparer, else the role holder, else the CEO (recorded as unfilled);
 *   - a completed engagement with a sent invoice reports open_balance_cents on GET /engagements
 *     and is counted in completedUnpaid on the executive dashboard.
 * Plus ruling 15 (2026-09-20): a PAPER jurisdiction is satisfied by its recorded mailing, not by an
 * acknowledgment that will never come, and an acknowledgment for one is surfaced for review.
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
import { certifiedMailFollowUp, currentTaxYear, filingLane } from '../src/modules/tax/resolution.ts';

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

/**
 * A filed 1120S on its own client and Illinois business (businesses.state = IL), with the preparer
 * given. `jurisdictions` declares the list explicitly (what the Mark filed modal sends); without it
 * the return declares nothing and the defaults derived from the business's state stand in, which is
 * how every return filed before ruling 2 shipped still reads.
 */
async function filedBusinessReturn(
  last: string,
  preparerId: string | null,
  jurisdictions?: readonly string[]
): Promise<{ contactId: string; teId: string; engagementId: string; entity: string }> {
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
  for (const j of jurisdictions ?? []) {
    await app.db.query(`INSERT INTO tax_engagement_jurisdictions (tax_engagement_id, jurisdiction) VALUES ($1, $2)`, [teId, j]);
  }
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

test('a row for a state the return does not declare reads as needing review, opens an owned task, sends nothing and counts for nothing', async () => {
  const r = await filedBusinessReturn('Wrongstate', ana.id, ['federal', 'IL']);
  const rep = await ingest([BIZ_HEADER, bizRow(r.entity, 'Federal', 'Accepted'), bizRow(r.entity, 'WI', 'Accepted')]);
  assert.equal(rep.queued, 1, `only the federal row will send: ${JSON.stringify(rep)}`);
  assert.equal(rep.tasks, 1, 'the undeclared state is a task');
  const notes = await notesFor(rep.reportId);
  assert.equal(notes[1]!.state_code, 'WI', 'the row is recorded as what it is');
  assert.equal(notes[1]!.disposition, 'task', 'it reads as needing review, not as something that will send');
  assert.match(notes[1]!.note, /needs review/);
  assert.match(notes[1]!.note, /WI is not declared on this return/, 'naming the state and that it is not declared');
  assert.match(notes[1]!.note, /federal, IL/, 'and what the return does declare');
  assert.match(notes[1]!.note, /nothing sent/i);

  const task = await app.db.query<{ id: string; assigned_staff_id: string | null; source: string; source_type: string; title: string; description: string; priority: number }>(
    `SELECT id, assigned_staff_id, source::text AS source, source_type, title, description, priority FROM tasks WHERE source_type = 'efile_ack_review' AND source_id = $1`,
    [`${rep.reportId}:2`]);
  assert.equal(task.rows.length, 1, 'one task, through the one door');
  assert.equal(task.rows[0]!.assigned_staff_id, ana.id, 'owned by the return\'s preparer');
  assert.equal(task.rows[0]!.source, 'automation');
  assert.equal(task.rows[0]!.priority, 1);
  assert.match(task.rows[0]!.title, /WI/);
  assert.match(task.rows[0]!.description, /does not declare|not on that list/);
  const linked = await app.db.query<{ task_id: string | null }>(
    `SELECT task_id FROM efile_acknowledgments WHERE report_id = $1 AND row_index = 2`, [rep.reportId]);
  assert.equal(linked.rows[0]!.task_id, task.rows[0]!.id, 'the row points at the task it raised');

  let s = await returnState(r.teId);
  assert.equal(s.stage, 'filed', 'Wisconsin is not one of this return\'s jurisdictions');
  assert.equal(s.state_accepted_code, null, 'and it is not stamped on the return');
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), ['IL']);

  // The manual door refuses it in words rather than swallowing it.
  const manual = await app.inject({ method: 'POST', url: `/tax-engagements/${r.teId}/efile-result`, headers: auth(ana), payload: { result: 'accepted', jurisdiction: 'state', stateCode: 'WI', asOf: '2026-09-19' } });
  assert.equal(manual.statusCode, 409, manual.body);
  assert.equal(manual.json().error, 'jurisdiction_not_declared');
  assert.match(manual.json().message, /WI is not declared/);

  await ingest([BIZ_HEADER, bizRow(r.entity, 'IL', 'Accepted')]);
  s = await returnState(r.teId);
  assert.equal(s.stage, 'completed');
  assert.equal(s.state_accepted_code, 'IL');
});

test('a return declared federal-only completes on federal even though the entity has a state', async () => {
  // The preparer filed no Illinois return this year: the list says so, and completion believes the
  // list rather than the address.
  const r = await filedBusinessReturn('Federalonly', ana.id, ['federal']);
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), ['federal']);
  const fed = await ingest([BIZ_HEADER, bizRow(r.entity, 'Federal', 'Accepted')]);
  assert.equal(fed.queued, 1, JSON.stringify(fed));
  const s = await returnState(r.teId);
  assert.equal(s.stage, 'completed', 'nothing else was declared, so nothing else is awaited');
  assert.equal(s.engagement_status, 'completed');
  assert.match((await notesFor(fed.reportId))[0]!.note, /the return is complete/);
});

test('a return declared federal + two states waits on both: neither state alone finishes it', async () => {
  const r = await filedBusinessReturn('Twostates', ana.id, ['federal', 'IL', 'WI']);
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), ['federal', 'IL', 'WI']);

  const first = await ingest([BIZ_HEADER, bizRow(r.entity, 'Federal', 'Accepted'), bizRow(r.entity, 'IL', 'Accepted')]);
  assert.equal(first.queued, 2, JSON.stringify(first));
  assert.equal(first.tasks, 0, 'both states are declared, so neither is a review row');
  let s = await returnState(r.teId);
  assert.equal(s.stage, 'filed', 'Wisconsin has not answered');
  assert.equal(s.state_accepted_code, 'IL', 'the first state to accept fills the compatibility pair');
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), ['WI']);
  assert.match((await notesFor(first.reportId))[1]!.note, /waits on WI/);

  const wi = await ingest([BIZ_HEADER, bizRow(r.entity, 'WI', 'Accepted')]);
  assert.equal(wi.queued, 1, JSON.stringify(wi));
  s = await returnState(r.teId);
  assert.equal(s.stage, 'completed', 'the third acknowledgment completes it');
  assert.equal(s.state_accepted_code, 'IL', 'and the pair still names the first state, not the last');
  assert.equal(s.engagement_status, 'completed');
  const rows = await app.db.query<{ jurisdiction: string; accepted_on: string | null }>(
    `SELECT jurisdiction, accepted_on::text AS accepted_on FROM tax_engagement_jurisdictions
      WHERE tax_engagement_id = $1 ORDER BY (jurisdiction <> 'federal'), jurisdiction`, [r.teId]);
  assert.deepEqual(rows.rows.map((x) => x.jurisdiction), ['federal', 'IL', 'WI']);
  assert.ok(rows.rows.every((x) => x.accepted_on === '2026-09-19'), 'each jurisdiction carries its own acceptance date');
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

/*
 * ═══ 2026-09-20, RULING 15: PAPER FILING ═══════════════════════════════════════════════════════
 *
 * A jurisdiction carries HOW it was filed, and the two methods are satisfied by different facts: an
 * e-file jurisdiction by an acknowledgment, a paper one by a recorded MAILING. Before this, a return
 * declared on paper waited forever on an acceptance that does not exist — the same defect ruling 2
 * removed for the no-income-tax states, one lane over.
 *
 *   · federal e-file + IL paper completes on the federal ack PLUS the IL mailing;
 *   · an IL acknowledgment for that return is refused and surfaced for review, the way an undeclared
 *     state is: needs-review disposition, the reason on the row, an owned task, nothing counted;
 *   · an old year defaults every jurisdiction to paper and completes on mailings alone, with no
 *     e-file acceptance stamped on it;
 *   · a current-year return defaults to e-file and the preparer switches one state to paper.
 */

/**
 * A return filed THROUGH THE DOOR: the transition route, which is what the Mark filed modal calls,
 * so the declared list and its filing methods are written the way production writes them.
 */
async function readyToFileReturn(
  last: string,
  taxYear: number
): Promise<{ contactId: string; teId: string; engagementId: string; entity: string }> {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: last, email: `${last.toLowerCase()}-completion@example.test` });
  const entity = `Synthetic ${last}, LLC`;
  const biz = await app.inject({ method: 'POST', url: `/contacts/${c.id}/businesses`, headers: auth(brian), payload: { name: entity, ein: '55-5555555', entityType: 's_corp', state: 'IL' } });
  assert.equal(biz.statusCode, 201, biz.body);
  const created = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(ana), payload: {
    reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows',
    contactId: c.id, businessId: biz.json().id as string, taxYear, returnType: '1120s', clientType: 'business', preparerId: ana.id,
  } });
  assert.equal(created.statusCode, 201, created.body);
  const teId = created.json().id as string;
  await signed8879OnFile(app, teId, ana.id, `${taxYear + 1}-02-01`);
  await app.db.query(
    `UPDATE tax_engagements SET stage = 'ready_to_file', engagement_letter_signed_at = now(), estimate_locked_at = now() WHERE id = $1`,
    [teId]);
  return { contactId: c.id, teId, engagementId: created.json().engagementId as string, entity };
}

async function filedThroughTheDoor(
  last: string,
  taxYear: number,
  jurisdictions: readonly string[],
  filingMethods?: Record<string, 'efile' | 'paper'>
): Promise<{ contactId: string; teId: string; engagementId: string; entity: string }> {
  const r = await readyToFileReturn(last, taxYear);
  const filed = await app.inject({
    method: 'POST', url: `/tax-engagements/${r.teId}/transition`, headers: auth(ana),
    payload: { toStage: 'filed', preparerPtinHolderId: ana.id, jurisdictions, ...(filingMethods ? { filingMethods } : {}) },
  });
  assert.equal(filed.statusCode, 200, filed.body);
  return r;
}

async function jurisdictionRows(teId: string): Promise<Array<{
  jurisdiction: string; filing_method: string | null; accepted_on: string | null; mailed_on: string | null;
  mailing_method: string | null; tracking_number: string | null; receipt_document_id: string | null;
}>> {
  const { rows } = await app.db.query<{
    jurisdiction: string; filing_method: string | null; accepted_on: string | null; mailed_on: string | null;
    mailing_method: string | null; tracking_number: string | null; receipt_document_id: string | null;
  }>(
    `SELECT jurisdiction, filing_method, accepted_on::text AS accepted_on, mailed_on::text AS mailed_on,
            mailing_method, tracking_number, receipt_document_id
       FROM tax_engagement_jurisdictions WHERE tax_engagement_id = $1
      ORDER BY (jurisdiction <> 'federal'), jurisdiction`, [teId]);
  return rows;
}

const MAILED_ON = '2026-09-18';

test('a return declared federal e-file + IL paper completes on the federal acknowledgment plus the IL mailing', async () => {
  const r = await filedThroughTheDoor('Mixedlane', 2025, ['federal', 'IL'], { IL: 'paper' });
  const declared = await jurisdictionRows(r.teId);
  assert.deepEqual(declared.map((d) => [d.jurisdiction, d.filing_method]), [['federal', 'efile'], ['IL', 'paper']],
    'the modal said IL went on paper; federal took the lane the year implies');
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), ['federal', 'IL']);

  // The federal acknowledgment alone does not finish it: IL has not been mailed.
  const fed = await ingest([BIZ_HEADER, bizRow(r.entity, 'Federal', 'Accepted')]);
  assert.equal(fed.queued, 1, JSON.stringify(fed));
  let s = await returnState(r.teId);
  assert.equal(s.stage, 'filed');
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), ['IL'], 'the paper jurisdiction is what is left');
  assert.match((await notesFor(fed.reportId))[0]!.note, /waits on IL/);

  // The mailing is the paper lane's acceptance — and it completes the return.
  const mailed = await app.inject({
    method: 'POST', url: `/tax-engagements/${r.teId}/jurisdictions/IL/mailing`, headers: auth(ana),
    payload: { mailedOn: MAILED_ON, method: 'certified', trackingNumber: '9407 1111 2222 3333 4444 55', asOf: '2026-09-19' },
  });
  assert.equal(mailed.statusCode, 200, mailed.body);
  assert.equal(mailed.json().stage, 'completed');
  assert.deepEqual(mailed.json().awaiting, []);

  const rows = await jurisdictionRows(r.teId);
  const il = rows.find((d) => d.jurisdiction === 'IL')!;
  assert.equal(il.mailed_on, MAILED_ON);
  assert.equal(il.mailing_method, 'certified');
  assert.match(il.tracking_number!, /9407/);
  assert.equal(il.accepted_on, null, 'nothing accepted IL: a paper filing gets no acknowledgment');

  s = await returnState(r.teId);
  assert.equal(s.stage, 'completed');
  assert.equal(s.engagement_status, 'completed', 'closeEngagementIfAllReturnsDone followed the mailing');
  assert.ok(s.efile_accepted_at, 'federal really did accept, so the e-file stamp is honest');
  const summary = await app.db.query<{ paper_mailed_on: string | null; certified_tracking: string | null }>(
    `SELECT paper_mailed_on::text AS paper_mailed_on, certified_tracking FROM tax_engagements WHERE id = $1`, [r.teId]);
  assert.equal(summary.rows[0]!.paper_mailed_on, MAILED_ON, 'the summary columns are kept in step (0026)');

  const audited = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'tax_engagement.paper_mailed' AND object_id = $1`, [r.teId]);
  assert.equal(audited.rows.length, 1);
  assert.equal(audited.rows[0]!.details['jurisdiction'], 'IL');
  assert.equal(audited.rows[0]!.details['mailing_method'], 'certified');

  // Certified mail has tracking, so it earns a follow-up owned by the return's preparer.
  const task = await app.db.query<{ id: string; assigned_staff_id: string | null; due_date: string | null; source: string; priority: number; title: string }>(
    `SELECT id, assigned_staff_id, due_date::text AS due_date, source::text AS source, priority, title
       FROM tasks WHERE source_type = 'paper_mailing_followup' AND source_id = $1`, [`${r.teId}:IL`]);
  assert.equal(task.rows.length, 1, 'one follow-up, through the one door');
  assert.equal(task.rows[0]!.assigned_staff_id, ana.id);
  assert.equal(task.rows[0]!.due_date, certifiedMailFollowUp(MAILED_ON), 'due on the expected-delivery day, derived');
  assert.equal(task.rows[0]!.source, 'automation');
  assert.match(task.rows[0]!.title, /certified mail delivery/i);
  assert.equal(task.rows[0]!.id !== null, true);

  // A second mailing for the same jurisdiction is refused: the one that went out is the one that counts.
  const again = await app.inject({
    method: 'POST', url: `/tax-engagements/${r.teId}/jurisdictions/IL/mailing`, headers: auth(ana),
    payload: { mailedOn: MAILED_ON, method: 'first_class', asOf: '2026-09-19' } });
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error, 'mailing_already_recorded');
});

test('an acknowledgment for a jurisdiction filed on paper is refused and surfaced for review, and counts for nothing', async () => {
  const r = await filedThroughTheDoor('Paperack', 2025, ['federal', 'IL'], { IL: 'paper' });

  const rep = await ingest([BIZ_HEADER, bizRow(r.entity, 'Federal', 'Accepted'), bizRow(r.entity, 'IL', 'Accepted')]);
  assert.equal(rep.queued, 1, `only the federal row will send: ${JSON.stringify(rep)}`);
  assert.equal(rep.tasks, 1, 'the paper jurisdiction is a review row');
  const notes = await notesFor(rep.reportId);
  assert.equal(notes[1]!.state_code, 'IL');
  assert.equal(notes[1]!.disposition, 'task', 'it reads as needing review, not as something that will send');
  assert.match(notes[1]!.note, /needs review/);
  assert.match(notes[1]!.note, /filed on PAPER/);
  assert.match(notes[1]!.note, /nothing sent/i);

  const task = await app.db.query<{ id: string; assigned_staff_id: string | null; source_type: string; title: string; description: string; priority: number }>(
    `SELECT id, assigned_staff_id, source_type, title, description, priority FROM tasks WHERE source_type = 'efile_ack_review' AND source_id = $1`,
    [`${rep.reportId}:2`]);
  assert.equal(task.rows.length, 1, 'one task, through the one door');
  assert.equal(task.rows[0]!.assigned_staff_id, ana.id, "owned by the return's preparer");
  assert.equal(task.rows[0]!.priority, 1);
  assert.match(task.rows[0]!.title, /filed on paper/i);
  assert.match(task.rows[0]!.description, /no acknowledgment/);
  const linked = await app.db.query<{ task_id: string | null }>(
    `SELECT task_id FROM efile_acknowledgments WHERE report_id = $1 AND row_index = 2`, [rep.reportId]);
  assert.equal(linked.rows[0]!.task_id, task.rows[0]!.id);

  const rows = await jurisdictionRows(r.teId);
  assert.equal(rows.find((d) => d.jurisdiction === 'IL')!.accepted_on, null, 'nothing was stamped on the paper row');
  assert.equal((await returnState(r.teId)).state_accepted_code, null, 'and nothing reached the summary pair');
  assert.deepEqual(await jurisdictionsAwaiting(app, r.teId), ['IL'], 'IL still waits on its mailing');
  assert.equal((await returnState(r.teId)).stage, 'filed');

  // The manual door refuses it by name rather than swallowing it.
  const manual = await app.inject({
    method: 'POST', url: `/tax-engagements/${r.teId}/efile-result`, headers: auth(ana),
    payload: { result: 'accepted', jurisdiction: 'state', stateCode: 'IL', asOf: '2026-09-19' } });
  assert.equal(manual.statusCode, 409, manual.body);
  assert.equal(manual.json().error, 'jurisdiction_is_paper');
  assert.match(manual.json().message, /filed on paper/);

  // And a mailing on the E-FILE jurisdiction is the same category error, the other way round.
  const wrongWay = await app.inject({
    method: 'POST', url: `/tax-engagements/${r.teId}/jurisdictions/federal/mailing`, headers: auth(ana),
    payload: { mailedOn: MAILED_ON, method: 'certified', asOf: '2026-09-19' } });
  assert.equal(wrongWay.statusCode, 409, wrongWay.body);
  assert.equal(wrongWay.json().error, 'jurisdiction_is_efile');
});

test('an old year defaults every jurisdiction to paper and completes on the mailings alone', async () => {
  // 2021 is more than two years back, so the lane is paper — derived from the year, never chosen.
  const year = 2021;
  assert.equal(filingLane(year, '2026-09-19'), 'paper', 'the lane the year implies');
  const r = await filedThroughTheDoor('Oldyear', year, ['federal', 'IL']);
  const declared = await jurisdictionRows(r.teId);
  assert.deepEqual(declared.map((d) => [d.jurisdiction, d.filing_method]), [['federal', 'paper'], ['IL', 'paper']],
    'nobody said, so the year did');

  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${r.teId}`, headers: auth(ana) })).json() as {
    default_filing_method: string; paper_awaiting_mailing: string[];
    jurisdictions: Array<{ jurisdiction: string; filingMethod: string; mailedOn: string | null; acceptedOn: string | null }>;
  };
  assert.equal(detail.default_filing_method, 'paper', 'what the modal opens on for this return');
  assert.deepEqual(detail.paper_awaiting_mailing, ['federal', 'IL'], 'both need a Record mailing');
  assert.ok(detail.jurisdictions.every((j) => j.filingMethod === 'paper' && j.acceptedOn === null));

  const first = await app.inject({
    method: 'POST', url: `/tax-engagements/${r.teId}/jurisdictions/federal/mailing`, headers: auth(ana),
    payload: { mailedOn: MAILED_ON, method: 'certified', trackingNumber: '9407 5555 6666 7777 8888 99', asOf: '2026-09-19' } });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().stage, 'filed', 'IL has not been mailed');
  assert.deepEqual(first.json().awaiting, ['IL']);

  const second = await app.inject({
    method: 'POST', url: `/tax-engagements/${r.teId}/jurisdictions/IL/mailing`, headers: auth(ana),
    payload: { mailedOn: MAILED_ON, method: 'hand_delivered', asOf: '2026-09-19' } });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().stage, 'completed', 'the second mailing finished it');
  assert.equal(second.json().followUpTaskId, null, 'a hand-delivered filing has nothing to chase');

  const s = await returnState(r.teId);
  assert.equal(s.stage, 'completed');
  assert.equal(s.engagement_status, 'completed');
  assert.equal(s.efile_accepted_at, null, 'nothing was e-filed, so no e-file acceptance is stamped');
  assert.equal(s.federal_accepted_on, null);
  const tasks = await app.db.query<{ n: string }>(
    `SELECT count(*) AS n FROM tasks WHERE source_type = 'paper_mailing_followup' AND source_id LIKE $1`, [`${r.teId}:%`]);
  assert.equal(tasks.rows[0]!.n, '1', 'one follow-up: the certified mailing, not the hand delivery');

  // A future mailing date is refused: a mailing is recorded on the day it went out or after.
  const later = await filedThroughTheDoor('Futuremail', year, ['federal']);
  const future = await app.inject({
    method: 'POST', url: `/tax-engagements/${later.teId}/jurisdictions/federal/mailing`, headers: auth(ana),
    payload: { mailedOn: '2026-09-30', method: 'certified', asOf: '2026-09-19' } });
  assert.equal(future.statusCode, 400, future.body);
  assert.equal(future.json().error, 'mailed_on_future');
});

test('a current-year return defaults to e-file, and the preparer switches one state to paper', async () => {
  const year = currentTaxYear('2026-09-19');
  assert.equal(filingLane(year, '2026-09-19'), 'efile');
  const r = await filedThroughTheDoor('Currentyear', year, ['federal', 'IL']);
  assert.deepEqual((await jurisdictionRows(r.teId)).map((d) => d.filing_method), ['efile', 'efile'],
    'the current year e-files, on both jurisdictions, without anybody saying so');

  // The same year, the same state, the preparer saying IL went out on paper: one return, two lanes.
  const mixed = await filedThroughTheDoor('Currentmixed', year, ['federal', 'IL'], { IL: 'paper' });
  assert.deepEqual((await jurisdictionRows(mixed.teId)).map((d) => [d.jurisdiction, d.filing_method]),
    [['federal', 'efile'], ['IL', 'paper']]);
  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${mixed.teId}`, headers: auth(ana) })).json() as {
    default_filing_method: string; paper_awaiting_mailing: string[];
  };
  assert.equal(detail.default_filing_method, 'efile', 'the lane the year implies is still what the modal opens on');
  assert.deepEqual(detail.paper_awaiting_mailing, ['IL'], 'only the switched jurisdiction needs a mailing');

  // A filing method for a jurisdiction the filing does not declare is refused, not dropped: the
  // preparer said something about a jurisdiction this return does not file in.
  const undeclared = await readyToFileReturn('Methodstray', year);
  const stray = await app.inject({
    method: 'POST', url: `/tax-engagements/${undeclared.teId}/transition`, headers: auth(ana),
    payload: { toStage: 'filed', preparerPtinHolderId: ana.id, jurisdictions: ['federal'], filingMethods: { WI: 'paper' } } });
  assert.equal(stray.statusCode, 400, stray.body);
  assert.equal(stray.json().error, 'filing_method_undeclared_jurisdiction');
  assert.equal((await returnState(undeclared.teId)).stage, 'ready_to_file', 'and nothing was filed');
});

test('role proof (ruling 15): the mailing route refuses a bookkeeper; the preparer records one; the CEO by wildcard', async () => {
  const r = await filedThroughTheDoor('Mailrole', 2021, ['federal', 'IL']);
  const marian = await staffWithToken('marian-completion@example.test', 'bookkeeper');
  const refused = await app.inject({
    method: 'POST', url: `/tax-engagements/${r.teId}/jurisdictions/IL/mailing`, headers: auth(marian),
    payload: { mailedOn: MAILED_ON, method: 'certified', asOf: '2026-09-19' } });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().permission, 'engagements.tax.manage');

  const byPreparer = await app.inject({
    method: 'POST', url: `/tax-engagements/${r.teId}/jurisdictions/IL/mailing`, headers: auth(ana),
    payload: { mailedOn: MAILED_ON, method: 'first_class', asOf: '2026-09-19' } });
  assert.equal(byPreparer.statusCode, 200, byPreparer.body);

  const byCeo = await app.inject({
    method: 'POST', url: `/tax-engagements/${r.teId}/jurisdictions/federal/mailing`, headers: auth(brian),
    payload: { mailedOn: MAILED_ON, method: 'certified', trackingNumber: '9407 0000 1111 2222 3333 44', asOf: '2026-09-19' } });
  assert.equal(byCeo.statusCode, 200, byCeo.body);
  assert.equal(byCeo.json().stage, 'completed', 'the CEO holds it by wildcard, and that mailing finished the return');
});
