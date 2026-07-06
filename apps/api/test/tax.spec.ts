// M7 "Prove it": table-driven complexity tests, gate tests (engagement letter
// / estimate lock / 8879), scope-creep enforcement, stage-history rows with
// client/staff delay attribution. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeStaff, auditRows } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { computeComplexityScore } from '../src/modules/tax/complexity.ts';

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
