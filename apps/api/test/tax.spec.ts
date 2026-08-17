// M7 "Prove it": table-driven complexity tests, gate tests (engagement letter
// / estimate lock / 8879), scope-creep enforcement, stage-history rows with
// client/staff delay attribution. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeStaff, makeContact, auditRows } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { computeComplexityScore } from '../src/modules/tax/complexity.ts';
import { recordEfileResult } from '../src/modules/tax/pipeline.ts';

let app: FastifyInstance;
let config: Config;
let preparer: { token: string };
let intern: { token: string };
let contactId: string;

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffToken(email: string, role: string): Promise<{ token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email: staff.email, password: staff.password, totp: code },
  });
  assert.equal(res.statusCode, 200, res.body);
  return { token: res.json().token as string };
}

async function newTaxEngagement(): Promise<string> {
  const res = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(preparer),
    payload: { contactId, taxYear: 2025, returnType: '1040', clientType: 'individual' },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

async function move(id: string, toStage: string, expect = 200): Promise<{ statusCode: number; body: unknown }> {
  const res = await app.inject({
    method: 'POST', url: `/tax-engagements/${id}/transition`, headers: auth(preparer),
    payload: { toStage },
  });
  assert.equal(res.statusCode, expect, `→ ${toStage}: ${res.body}`);
  return { statusCode: res.statusCode, body: res.json() };
}

before(async () => {
  config = await createTestConfig('tax');
  app = buildServer(config);
  await app.ready();
  preparer = await staffToken('anamaria-test@example.test', 'tax_preparer');
  intern = await staffToken('intern-tax@example.test', 'intern');
  const contact = await app.db.query<{ id: string }>(
    `INSERT INTO contacts (first_name, last_name, email, soto_status)
     VALUES ('Synthetic', 'Taxpayer', 'taxpayer@example.test', 'active') RETURNING id`
  );
  contactId = contact.rows[0]!.id;
});

after(async () => {
  await app.close();
});

test('complexity score: table-driven per the MP formula, capped at L5', () => {
  const cases: Array<[Parameters<typeof computeComplexityScore>[0], number]> = [
    [{}, 1],
    [{ schC: 1 }, 2],
    [{ schC: 2 }, 3],
    [{ schEProperties: 3 }, 2.5],
    [{ k1s: 2 }, 2],
    [{ states: 1 }, 1],                       // first state included
    [{ states: 3 }, 2],                       // two additional states
    [{ foreign: true }, 2],
    [{ depreciation: true, lateDocs: true }, 2],
    [{ priorYearCleanup: true, irsNotice: true }, 3],
    [{ schC: 1, schEProperties: 2, k1s: 1, states: 2, foreign: true, depreciation: true }, 5],
    [{ schC: 4, schEProperties: 6, foreign: true, irsNotice: true }, 5], // cap
  ];
  for (const [inputs, expected] of cases) {
    assert.equal(computeComplexityScore(inputs), expected, JSON.stringify(inputs));
  }
});

test('RBAC: intern cannot create tax engagements; preparer can (history row written)', async () => {
  const refused = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(intern),
    payload: { contactId, taxYear: 2025, returnType: '1040' },
  });
  assert.equal(refused.statusCode, 403);

  const id = await newTaxEngagement();
  const detail = await app.inject({ method: 'GET', url: `/tax-engagements/${id}`, headers: auth(preparer) });
  assert.equal(detail.json().taxEngagement.stage, 'intake_started');
  assert.ok(detail.json().taxEngagement.price_book_version_id, 'parent engagement pins the price book');
  assert.equal(detail.json().stageHistory.length, 1);
  assert.equal(detail.json().stageHistory[0].stage, 'intake_started');
});

test('full pipeline march with all three gates enforced', async () => {
  const id = await newTaxEngagement();

  await move(id, 'scheduled');

  // GATE 1: cannot advance past Scheduled without the engagement letter.
  const blocked = await move(id, 'documents_requested', 409);
  assert.equal((blocked.body as { error: string }).error, 'engagement_letter_required');

  const wetLetter = await app.inject({
    method: 'POST', url: `/tax-engagements/${id}/signatures/wet`, headers: auth(preparer),
    payload: { type: 'engagement_letter' },
  });
  assert.equal(wetLetter.statusCode, 200, wetLetter.body);
  const contactRow = await app.db.query(`SELECT engagement_letter_status FROM contacts WHERE id = $1`, [contactId]);
  assert.equal(contactRow.rows[0].engagement_letter_status, 'signed');

  // Automation 4 side-effect: document request → pending_client_response.
  const docReq = await app.inject({
    method: 'POST', url: '/document-requests', headers: auth(preparer),
    payload: { taxEngagementId: id, titleEn: '2025 tax documents', titleEs: 'Documentos de impuestos 2025' },
  });
  assert.equal(docReq.statusCode, 201, docReq.body);
  let detail = await app.inject({ method: 'GET', url: `/tax-engagements/${id}`, headers: auth(preparer) });
  assert.equal(detail.json().taxEngagement.stage, 'pending_client_response');
  assert.ok(detail.json().taxEngagement.docs_requested_at, 'docs_requested_at stamped');
  const pending = detail.json().stageHistory.find((h: { stage: string }) => h.stage === 'pending_client_response');
  assert.equal(pending.waiting_on, 'client', 'delay attribution: client court');

  // GATE 2 (automation 8): estimate must be locked before preparation.
  const noEstimate = await move(id, 'in_preparation', 409);
  assert.equal((noEstimate.body as { error: string }).error, 'estimate_lock_required');

  const estimate = await app.inject({
    method: 'POST', url: `/tax-engagements/${id}/estimate`, headers: auth(preparer),
    payload: { minCents: 20000, maxCents: 38000 },
  });
  assert.equal(estimate.statusCode, 200, estimate.body);
  assert.ok((await auditRows(app.db, 'tax_engagement.estimate_locked')) >= 1);

  await move(id, 'in_preparation');
  await move(id, 'internal_review');
  await move(id, 'client_review');
  await move(id, 'ready_to_file');

  // GATE 3: no filing without a signed 8879.
  const no8879 = await move(id, 'filed', 409);
  assert.equal((no8879.body as { error: string }).error, 'f8879_required');

  const wet8879 = await app.inject({
    method: 'POST', url: `/tax-engagements/${id}/signatures/wet`, headers: auth(preparer),
    payload: { type: 'f8879', note: 'signed in office, scanned' },
  });
  assert.equal(wet8879.statusCode, 200, wet8879.body);

  await move(id, 'filed');
  detail = await app.inject({ method: 'GET', url: `/tax-engagements/${id}`, headers: auth(preparer) });
  assert.equal(detail.json().taxEngagement.f8879_signature_method, 'in_person_wet', 'signature method recorded per 8879');
  assert.ok(detail.json().taxEngagement.filed_date, 'filed_date auto-stamped');

  await move(id, 'completed');
  const history = detail.json().stageHistory.map((h: { stage: string }) => h.stage);
  assert.deepEqual(
    history,
    ['intake_started', 'scheduled', 'documents_requested', 'pending_client_response', 'in_preparation', 'internal_review', 'client_review', 'ready_to_file', 'filed'],
    'every transition leaves a history row in order'
  );
});

test('invalid jumps are refused; on_hold resume re-applies gates', async () => {
  const id = await newTaxEngagement();

  const jump = await move(id, 'filed', 409);
  assert.equal((jump.body as { error: string }).error, 'invalid_transition');

  await move(id, 'scheduled');
  await move(id, 'on_hold');
  // Resuming straight into preparation is blocked: letter + estimate gates apply.
  const resumeBlocked = await move(id, 'in_preparation', 409);
  assert.equal((resumeBlocked.body as { error: string }).error, 'engagement_letter_required');
  await move(id, 'scheduled'); // resume where it left off — fine
});

test('scope creep: auto-flag when final exceeds estimate top, reason REQUIRED', async () => {
  const id = await newTaxEngagement();
  await app.inject({
    method: 'POST', url: `/tax-engagements/${id}/estimate`, headers: auth(preparer),
    payload: { minCents: 20000, maxCents: 30000 },
  });

  // Under the top: no flag.
  const under = await app.inject({
    method: 'POST', url: `/tax-engagements/${id}/final-fee`, headers: auth(preparer),
    payload: { finalFeeCents: 28000 },
  });
  assert.equal(under.statusCode, 200);
  assert.equal(under.json().scopeCreepFlag, false);

  // Over the top without a reason: refused.
  const noReason = await app.inject({
    method: 'POST', url: `/tax-engagements/${id}/final-fee`, headers: auth(preparer),
    payload: { finalFeeCents: 41000 },
  });
  assert.equal(noReason.statusCode, 409);
  assert.equal(noReason.json().error, 'scope_creep_reason_required');

  // 'other' requires a description.
  const otherNoDesc = await app.inject({
    method: 'POST', url: `/tax-engagements/${id}/final-fee`, headers: auth(preparer),
    payload: { finalFeeCents: 41000, scopeCreepReason: 'other' },
  });
  assert.equal(otherNoDesc.statusCode, 409);
  assert.equal(otherNoDesc.json().error, 'scope_creep_description_required');

  // With a reason: flagged + audited.
  const flagged = await app.inject({
    method: 'POST', url: `/tax-engagements/${id}/final-fee`, headers: auth(preparer),
    payload: { finalFeeCents: 41000, scopeCreepReason: 'late_docs' },
  });
  assert.equal(flagged.statusCode, 200, flagged.body);
  assert.equal(flagged.json().scopeCreepFlag, true);
  assert.ok((await auditRows(app.db, 'tax_engagement.scope_creep_flagged')) >= 1);

  const row = await app.db.query(
    `SELECT scope_creep_flag, scope_creep_reason FROM tax_engagements WHERE id = $1`,
    [id]
  );
  assert.equal(row.rows[0].scope_creep_flag, true);
  assert.equal(row.rows[0].scope_creep_reason, 'late_docs');
});

test('complexity endpoint stores score + inputs', async () => {
  const id = await newTaxEngagement();
  const res = await app.inject({
    method: 'POST', url: `/tax-engagements/${id}/complexity`, headers: auth(preparer),
    payload: { schC: 1, schEProperties: 2, states: 2, lateDocs: true },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().complexityScore, 4); // 1 + 1 + 1 + 0.5 + 0.5
  const row = await app.db.query(`SELECT complexity_score, complexity_inputs FROM tax_engagements WHERE id = $1`, [id]);
  assert.equal(Number(row.rows[0].complexity_score), 4);
  assert.equal(row.rows[0].complexity_inputs.schEProperties, 2);
});

// ── M26 flow 1: e-file rejects — Filed is not terminal until acceptance ──────

test('e-file result: accepted completes; rejected re-queues with perfection clock + owned fix task', async () => {
  // Fabricate a filed 1040 (gates satisfied) — the individual lane: 5 days.
  const accepted = await newTaxEngagement();
  await app.db.query(
    `UPDATE tax_engagements
     SET stage = 'filed', engagement_letter_signed_at = now(), estimate_locked_at = now(),
         f8879_signed_at = now(), filed_date = '2026-08-01', invoice_number = 'INV-SYNTH-1'
     WHERE id = $1`,
    [accepted]
  );
  const ok = await app.inject({
    method: 'POST', url: `/tax-engagements/${accepted}/efile-result`, headers: auth(preparer),
    payload: { result: 'accepted' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().stage, 'completed');
  const acc = await app.db.query(`SELECT stage, efile_accepted_at FROM tax_engagements WHERE id = $1`, [accepted]);
  assert.equal(acc.rows[0].stage, 'completed');
  assert.ok(acc.rows[0].efile_accepted_at);

  // Rejected: 1040 → 5-day perfection window from asOf.
  const rejected = await newTaxEngagement();
  await app.db.query(
    `UPDATE tax_engagements
     SET stage = 'filed', engagement_letter_signed_at = now(), estimate_locked_at = now(),
         f8879_signed_at = now(), filed_date = '2026-08-01', invoice_number = 'INV-SYNTH-2'
     WHERE id = $1`,
    [rejected]
  );
  const rej = await app.inject({
    method: 'POST', url: `/tax-engagements/${rejected}/efile-result`, headers: auth(preparer),
    payload: { result: 'rejected', rejectCode: 'IND-181', rejectReason: 'Prior-year AGI mismatch', asOf: '2026-08-05' },
  });
  assert.equal(rej.statusCode, 200, rej.body);
  assert.equal(rej.json().stage, 'rejected');
  assert.equal(rej.json().perfectionDeadline, '2026-08-10', '1040 = 5 perfection days');

  const row = await app.db.query(
    `SELECT stage, reject_code, perfection_deadline::text AS pd FROM tax_engagements WHERE id = $1`,
    [rejected]
  );
  assert.equal(row.rows[0].stage, 'rejected');
  assert.equal(row.rows[0].reject_code, 'IND-181');
  assert.equal(row.rows[0].pd, '2026-08-10');

  // Owned fix task, urgent, due at the perfection deadline.
  const task = await app.db.query<{ id: string; priority: number; due_date: string; status: string }>(
    `SELECT id, priority, due_date::text AS due_date, status FROM tasks
     WHERE source_type = 'efile_reject' AND source_id = $1`,
    [rejected]
  );
  assert.equal(task.rows.length, 1, 'rejects are OWNED, never dead-ended');
  assert.equal(task.rows[0]!.priority, 2);
  assert.equal(task.rows[0]!.due_date, '2026-08-10');

  // E-file results only apply to filed returns.
  const notFiled = await newTaxEngagement();
  const nope = await app.inject({
    method: 'POST', url: `/tax-engagements/${notFiled}/efile-result`, headers: auth(preparer),
    payload: { result: 'accepted' },
  });
  assert.equal(nope.statusCode, 409);

  // Re-queue: rejected → ready_to_file → filed clears the clock + closes the task.
  await move(rejected, 'ready_to_file');
  await move(rejected, 'filed');
  const after = await app.db.query(`SELECT perfection_deadline FROM tax_engagements WHERE id = $1`, [rejected]);
  assert.equal(after.rows[0].perfection_deadline, null, 'clock stops on re-file');
  const closed = await app.db.query(`SELECT status FROM tasks WHERE id = $1`, [task.rows[0]!.id]);
  assert.equal(closed.rows[0].status, 'completed', 'fix task auto-closed');
});

test('perfection clock job: T-2 warns the preparer, past-deadline escalates to Brian, date-guarded', async () => {
  const brianTok = await staffToken('brian-tax-perf@example.test', 'ceo');
  void brianTok;
  const brianRow = await app.db.query<{ id: string }>(
    `SELECT id FROM staff WHERE email = 'brian-tax-perf@example.test'`
  );
  const preparerRow = await app.db.query<{ id: string }>(
    `SELECT id FROM staff WHERE email = 'anamaria-test@example.test'`
  );

  const closing = await newTaxEngagement();
  await app.db.query(
    `UPDATE tax_engagements SET stage = 'rejected', perfection_deadline = '2026-08-11', preparer_id = $2 WHERE id = $1`,
    [closing, preparerRow.rows[0]!.id]
  );
  const missed = await newTaxEngagement();
  await app.db.query(
    `UPDATE tax_engagements SET stage = 'rejected', perfection_deadline = '2026-08-01', preparer_id = $2 WHERE id = $1`,
    [missed, preparerRow.rows[0]!.id]
  );

  const { runPerfectionClockJob } = await import('../src/modules/tax/pipeline.ts');
  const run = await runPerfectionClockJob(app, '2026-08-09');
  assert.equal(run.skipped, false);
  assert.ok(run.warnings >= 1, 'T-2 warning fired');
  assert.ok(run.overdue >= 1, 'missed window escalated');

  const warn = await app.db.query(
    `SELECT 1 FROM notifications WHERE type = 'perfection_closing' AND related_object_id = $1`,
    [closing]
  );
  assert.equal(warn.rows.length, 1);
  const esc = await app.db.query(
    `SELECT 1 FROM notifications WHERE type = 'perfection_overdue' AND staff_id = $1 AND related_object_id = $2`,
    [brianRow.rows[0]!.id, missed]
  );
  assert.equal(esc.rows.length, 1);

  // Same-day rerun: date guard.
  const rerun = await runPerfectionClockJob(app, '2026-08-09');
  assert.equal(rerun.skipped, true);
});

/*
 * #44 §4 — a return reaching its terminal stage finishes the engagement holding it.
 *
 * `completed` was terminal in the tax pipeline from the start and NOTHING propagated it.
 * So an accepted return sat inside a permanently active engagement, and the client kept
 * reading as active because an "open" engagement existed — the same untruth as #42's
 * "lead", one level down, waiting for the first IRS acceptance.
 */
test('an accepted return closes its engagement, and the client follows when the last one does', async () => {
  /*
   * ONE ENGAGEMENT HOLDS ONE RETURN — tax_engagements.engagement_id is UNIQUE. My design
   * justified this check with "a client with a 2024 and a 2025 return on one engagement",
   * which the schema does not allow: two years are two engagements. The check that every
   * return is terminal stays (it is correct, and cheap if that constraint is ever
   * relaxed), but the case worth testing is the real one — a client with TWO engagements
   * does not become dormant when the first finishes.
   */
  const { refreshContactStatus } = await import('../src/modules/crm/lifecycle.ts');
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Twoyears', email: 'twoyears@example.test',
  });
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  await app.db.query(
    `INSERT INTO engagement_packets (contact_id, master_template_key, master_version, schedule_codes, status, signed_at, signature_method)
     VALUES ($1, 'engagement_master', 1, ARRAY[]::text[], 'signed', now(), 'portal_esign')`,
    [c.id]
  );

  const mkYear = async (year: number) => {
    const eng = await app.db.query<{ id: string }>(
      `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
       VALUES ($1, 'tax', 'active', $2) RETURNING id`,
      [c.id, version.rows[0]!.id]
    );
    const te = await app.db.query<{ id: string }>(
      `INSERT INTO tax_engagements
         (engagement_id, tax_year, return_type, stage, engagement_letter_signed_at,
          estimate_locked_at, f8879_signed_at)
       VALUES ($1, $2, '1040', 'filed', now(), now(), now()) RETURNING id`,
      [eng.rows[0]!.id, year]
    );
    return { engagementId: eng.rows[0]!.id, returnId: te.rows[0]!.id };
  };
  const y2024 = await mkYear(2024);
  const y2025 = await mkYear(2025);
  await refreshContactStatus(app, c.id, 'test');

  const actor = { staffId: null, label: 'test' };
  await recordEfileResult(app, actor, y2024.returnId, { result: 'accepted' });

  const first = await app.db.query<{ status: string; ended_on: string | null; close_reason: string | null }>(
    `SELECT status::text AS status, ended_on::text AS ended_on, close_reason FROM engagements WHERE id = $1`,
    [y2024.engagementId]
  );
  assert.equal(first.rows[0]!.status, 'completed', 'the accepted return finished its own engagement');
  assert.ok(first.rows[0]!.ended_on, 'a closed engagement has an end date');
  assert.match(first.rows[0]!.close_reason ?? '', /filed and accepted/);

  const other = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM engagements WHERE id = $1`, [y2025.engagementId]
  );
  assert.equal(other.rows[0]!.status, 'active', 'the other year is untouched');

  const midway = await app.db.query<{ contact_status: string }>(
    `SELECT contact_status::text AS contact_status FROM contacts WHERE id = $1`, [c.id]
  );
  assert.equal(midway.rows[0]!.contact_status, 'active', 'still active — one engagement is still open');

  await recordEfileResult(app, actor, y2025.returnId, { result: 'accepted' });

  /*
   * The last engagement closing is what moves the client, and it comes from the EVENT now
   * rather than the health sweep that was standing in for it (#42).
   */
  const done = await app.db.query<{ contact_status: string }>(
    `SELECT contact_status::text AS contact_status FROM contacts WHERE id = $1`, [c.id]
  );
  assert.equal(done.rows[0]!.contact_status, 'dormant',
    'the last engagement closing moves the client to dormant, from the event rather than a sweep');
});

test('a REJECTED return does not finish anything — it is still open work', async () => {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Rejected', email: 'rejected-close@example.test',
  });
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'tax', 'active', $2) RETURNING id`,
    [c.id, version.rows[0]!.id]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements
       (engagement_id, tax_year, return_type, stage, engagement_letter_signed_at,
        estimate_locked_at, f8879_signed_at)
     VALUES ($1, 2025, '1040', 'filed', now(), now(), now()) RETURNING id`,
    [eng.rows[0]!.id]
  );

  await recordEfileResult(app, { staffId: null, label: 'test' }, te.rows[0]!.id, {
    result: 'rejected', rejectCode: 'IND-031-04', rejectReason: 'AGI mismatch',
  });

  const still = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM engagements WHERE id = $1`, [eng.rows[0]!.id]
  );
  assert.equal(still.rows[0]!.status, 'active',
    'a reject re-queues with a perfection clock — that is open work, not a finished engagement');
});

test('withdrawing needs a reason, and closing twice is refused', async () => {
  const { closeEngagement } = await import('../src/modules/engagements/close.ts');
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Withdrawme', email: 'withdrawme@example.test',
  });
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'bookkeeping', 'active', $2) RETURNING id`,
    [c.id, version.rows[0]!.id]
  );
  const actor = { type: 'staff' as const, id: null, label: 'test' };

  await assert.rejects(
    closeEngagement(app, eng.rows[0]!.id, { outcome: 'withdrawn' }, actor),
    /reason/i,
    'work that ended without being delivered has to say why'
  );

  await closeEngagement(app, eng.rows[0]!.id, { outcome: 'withdrawn', reason: 'Client sold the business.' }, actor);

  await assert.rejects(
    closeEngagement(app, eng.rows[0]!.id, { outcome: 'completed', reason: 'oops' }, actor),
    /already closed/i,
    'a second click must not silently overwrite the outcome someone recorded'
  );

  // And the database refuses it too, not just the service.
  await assert.rejects(
    app.db.query(`UPDATE engagements SET close_reason = NULL WHERE id = $1`, [eng.rows[0]!.id]),
    /engagements_withdrawn_has_reason/
  );
});
