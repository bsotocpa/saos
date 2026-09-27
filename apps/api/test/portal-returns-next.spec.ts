/*
 * MY RETURNS, THE COMPLETED LINE PER JURISDICTION (Brian, 2026-09-26, R48).
 *
 *   "The portal 'what happens next' wording is approved except the completed line, which reads per
 *    jurisdiction: 'Accepted by the IRS on <date>. Accepted by Illinois on <date>.' or 'Mailed to
 *    Illinois on <date>.'"
 *
 * GET /portal/returns folds the return's state into `next_step` and, for a completed return, carries
 * `completed_lines`: one entry per declared jurisdiction (tax_engagement_jurisdictions), an e-file row
 * by its acceptance day and a paper row by its mailing day, in the order federal, then the states. The
 * portal names the jurisdiction in the reader's language and renders the day through its date helper.
 * A return with no declared rows (completed before migration 0104) reads the summary columns.
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, multipartBody, signed8879OnFile, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const PDF = Buffer.from('%PDF-1.4 synthetic test return — no real client data\n%%EOF');
const TODAY = '2026-09-26';

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

/** Sign a contact in the way the portal does, returning the session cookie header. */
async function portalCookie(contactId: string, email: string): Promise<{ cookie: string }> {
  const pu = await app.db.query<{ id: string }>(`INSERT INTO portal_users (contact_id, email) VALUES ($1, $2) RETURNING id`, [contactId, email]);
  const { randomBytes, createHash } = await import('node:crypto');
  const token = randomBytes(32).toString('base64url');
  await app.db.query(
    `INSERT INTO portal_sessions (portal_user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [pu.rows[0]!.id, createHash('sha256').update(token).digest('hex')]
  );
  return { cookie: `saos_portal_session=${token}` };
}

/**
 * A filed 1040 with its delivered copy under My Returns, declaring federal (e-file) and IL (paper).
 * The stage and the declared rows are written the way completion.spec.ts writes its fixtures; the
 * delivered copy goes through the documents door so the row is a real return_deliverable.
 */
async function filedReturn(tag: string, jurisdictions: Array<{ code: string; method: 'efile' | 'paper' }>) {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: tag, email: `${tag.toLowerCase()}-returnsnext@example.test` });
  const te = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { reason: 'Return opened by hand for the fixture; the client engaged by phone and the quote follows', contactId: c.id, taxYear: 2025, returnType: '1040' },
  });
  assert.equal(te.statusCode, 201, te.body);
  const teId = te.json().id as string;
  await signed8879OnFile(app, teId, ana.id);
  await app.db.query(
    `UPDATE tax_engagements SET stage = 'filed', engagement_letter_signed_at = now(), estimate_locked_at = now(),
            preparer_id = $2, preparer_ptin_holder_id = COALESCE(preparer_ptin_holder_id, $2) WHERE id = $1`,
    [teId, ana.id]);
  for (const j of jurisdictions) {
    await app.db.query(`INSERT INTO tax_engagement_jurisdictions (tax_engagement_id, jurisdiction, filing_method) VALUES ($1, $2, $3)`, [teId, j.code, j.method]);
  }
  const up = multipartBody(
    { contactId: c.id, category: 'return_deliverable', taxEngagementId: teId, taxYear: '2025' },
    { field: 'file', filename: `${tag}-2025-1040.pdf`, contentType: 'application/pdf', data: PDF }
  );
  const doc = await app.inject({ method: 'POST', url: '/documents', headers: { ...auth(ana), ...up.headers }, payload: up.payload });
  assert.equal(doc.statusCode, 201, doc.body);
  return { contactId: c.id, teId };
}

async function myReturns(cookie: { cookie: string }) {
  const res = await app.inject({ method: 'GET', url: '/portal/returns', headers: cookie });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json() as { returns: Array<{ next_step: string | null; completed_lines: Array<{ jurisdiction: string; kind: string; answered_on: string }> }> };
  assert.equal(body.returns.length, 1, res.body);
  return body.returns[0]!;
}

before(async () => {
  config = await createTestConfig('portalreturnsnext');
  const mailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  ana = await staffWithToken('ana-returnsnext@example.test', 'tax_preparer');
  await app.db.query(`UPDATE automations SET enabled = false WHERE key IN ('efile_acknowledgment', 'return_delivered')`);
});
after(async () => { await app.close(); });

test('R48: a completed return with federal accepted and Illinois mailed carries one line per jurisdiction, federal first', async () => {
  const r = await filedReturn('Completedlines', [{ code: 'federal', method: 'efile' }, { code: 'IL', method: 'paper' }]);
  const cookie = await portalCookie(r.contactId, 'completedlines-portal@example.test');

  // FILED, nothing answered yet: the filed sentence, no lines.
  let mine = await myReturns(cookie);
  assert.equal(mine.next_step, 'filed');
  assert.deepEqual(mine.completed_lines, []);

  // THE IRS ACCEPTS: the return still waits on Illinois, so still 'filed' and still no lines.
  const fed = await app.inject({ method: 'POST', url: `/tax-engagements/${r.teId}/efile-result`, headers: auth(ana), payload: { result: 'accepted', jurisdiction: 'federal', asOf: TODAY } });
  assert.equal(fed.statusCode, 200, fed.body);
  assert.deepEqual(fed.json().awaiting, ['IL']);
  mine = await myReturns(cookie);
  assert.equal(mine.next_step, 'filed');
  assert.deepEqual(mine.completed_lines, []);

  // ILLINOIS MAILED (the paper lane's acceptance): the return completes and the lines read per jurisdiction.
  const mailed = await app.inject({
    method: 'POST', url: `/tax-engagements/${r.teId}/jurisdictions/IL/mailing`, headers: auth(ana),
    payload: { mailedOn: '2026-09-25', method: 'first_class', asOf: TODAY },
  });
  assert.equal(mailed.statusCode, 200, mailed.body);
  assert.equal(mailed.json().stage, 'completed');
  mine = await myReturns(cookie);
  assert.equal(mine.next_step, 'accepted');
  assert.deepEqual(mine.completed_lines, [
    { jurisdiction: 'federal', kind: 'accepted', answered_on: TODAY },
    { jurisdiction: 'IL', kind: 'mailed', answered_on: '2026-09-25' },
  ]);
  for (const l of mine.completed_lines) assert.match(l.answered_on, /^\d{4}-\d{2}-\d{2}$/, 'a calendar day, never an instant');
});

test('R48: a return completed before the jurisdictions table reads its lines from the summary columns', async () => {
  const r = await filedReturn('Summarylines', []);
  const cookie = await portalCookie(r.contactId, 'summarylines-portal@example.test');
  await app.db.query(
    `UPDATE tax_engagements SET stage = 'completed', federal_accepted_on = '2026-03-02', state_accepted_on = '2026-03-04', state_accepted_code = 'il' WHERE id = $1`,
    [r.teId]);
  const mine = await myReturns(cookie);
  assert.equal(mine.next_step, 'accepted');
  assert.deepEqual(mine.completed_lines, [
    { jurisdiction: 'federal', kind: 'accepted', answered_on: '2026-03-02' },
    { jurisdiction: 'IL', kind: 'accepted', answered_on: '2026-03-04' },
  ]);
});
