/*
 * REOPEN A COMPLETED RETURN (Brian, 2026-09-26, R67) — the API half.
 *
 *  · the CEO alone holds the door (engagements.tax.reopen, explicit-only: the wildcard does not
 *    reach it); the preparer is refused 403 in the server's words; a chat artifact is not a reason;
 *  · only a completed return is reopened; a filed one is refused by name;
 *  · reopening moves the return back to filed with reopened_at and the reason, returns the
 *    engagement to active, clears the acceptance summary, writes a stage-history line and two audit
 *    rows (tax_engagement.reopened, engagement.reopened);
 *  · the executive count reads the return as open again;
 *  · every jurisdiction's earlier answer is STALE: GET says which, awaiting lists them, and a
 *    transition to completed is refused until a NEW acceptance (or mailing, on a paper row) is
 *    recorded after the reopen — then the return completes and the engagement closes again.
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, signed8879OnFile, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { addDays, todayChicago } from '../src/modules/tax/deadlines.ts';
import { EXPLICIT_ONLY_PERMISSIONS } from '../src/plugins/auth.ts';
import { currentPriceBookVersion } from '../src/modules/pricing/service.ts';

let app: FastifyInstance;
let config: Config;
let ana: TestStaff & { token: string };
let brian: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const today = todayChicago();
const SIGNED_ON = addDays(today, -10);
const REASON = 'The acknowledgment that completed this return belonged to the amended filing; the original still awaits the IRS.';

async function staffWithToken(email: string, role: string, name: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('reopen_return');
  const mailer: Mailer = { transport: 'console', async send() { return { id: 'x' }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  ana = await staffWithToken('ana-reopen@example.test', 'tax_preparer', 'Synthetic Preparer');
  brian = await staffWithToken('brian-reopen@example.test', 'ceo', 'Synthetic CEO');
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'efile_acknowledgment'`);
});
after(async () => { await app.close(); });

/** A 2025 1120S at ready_to_file on its own active engagement: the letter, the lock, Ana assigned, the signed 8879 on file. */
async function readyReturn(last: string): Promise<{ id: string; contactId: string; engagementId: string }> {
  const contactId = (await makeContact(app.db, { firstName: 'Synthetic', lastName: last, email: `${last.toLowerCase()}-reopen@example.test` })).id;
  const version = await currentPriceBookVersion(app.db);
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, title, status, period_key, price_book_version_id)
     VALUES ($1, 'tax', '2025 1120S', 'active', '2025', $2) RETURNING id`,
    [contactId, version.id]
  );
  const te = await app.db.query<{ id: string }>(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, client_type, stage, preparer_id, engagement_letter_signed_at, estimate_locked_at)
     VALUES ($1, 2025, '1120s', 'business', 'ready_to_file', $2, now(), now()) RETURNING id`,
    [eng.rows[0]!.id, ana.id]
  );
  await signed8879OnFile(app, te.rows[0]!.id, ana.id, SIGNED_ON);
  return { id: te.rows[0]!.id, contactId, engagementId: eng.rows[0]!.id };
}
const file = (id: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/tax-engagements/${id}/transition`, headers: auth(ana), payload: { toStage: 'filed', preparerPtinHolderId: ana.id, jurisdictions: ['federal'], ...payload } });
const accept = (id: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/tax-engagements/${id}/efile-result`, headers: auth(ana), payload: { result: 'accepted', ...payload } });
const reopen = (id: string, who: { token: string } = brian, reason: string = REASON) =>
  app.inject({ method: 'POST', url: `/tax-engagements/${id}/reopen`, headers: auth(who), payload: { reason } });
/** A completed return: filed federal-only, accepted by the IRS, its engagement closed by the acceptance. */
async function completedReturn(last: string) {
  const te = await readyReturn(last);
  assert.equal((await file(te.id)).statusCode, 200);
  const acc = await accept(te.id);
  assert.equal(acc.statusCode, 200, acc.body);
  assert.equal(acc.json().stage, 'completed');
  return te;
}
async function state(id: string) {
  const { rows } = await app.db.query<{
    stage: string; reopened_at: Date | null; reopen_reason: string | null; efile_accepted_at: Date | null; federal_accepted_on: string | null;
    engagement_status: string; ended_on: string | null;
  }>(
    `SELECT te.stage::text AS stage, te.reopened_at, te.reopen_reason, te.efile_accepted_at, te.federal_accepted_on::text AS federal_accepted_on,
            e.status::text AS engagement_status, e.ended_on::text AS ended_on
       FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE te.id = $1`, [id]);
  return rows[0]!;
}
async function filedCount(): Promise<number> {
  const res = await app.inject({ method: 'GET', url: '/dashboards/executive', headers: auth(brian) });
  assert.equal(res.statusCode, 200, res.body);
  const row = (res.json().openReturnsByStage as Array<{ stage: string; count: number }>).find((s) => s.stage === 'filed');
  return row ? Number(row.count) : 0;
}

test('role proof and the door\'s edges: explicit-only and seeded to the CEO alone; the preparer is refused 403 in the server\'s words; a filed return is refused; a chat artifact is not a reason', async () => {
  assert.ok(EXPLICIT_ONLY_PERMISSIONS.has('engagements.tax.reopen'), 'the wildcard does not reach it');
  const holders = await app.db.query<{ key: string }>(
    `SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission = 'engagements.tax.reopen' ORDER BY 1`);
  assert.deepEqual(holders.rows.map((r) => r.key), ['ceo'], 'seeded to the CEO alone');

  const done = await completedReturn('Edges');
  const preparer = await reopen(done.id, ana);
  assert.equal(preparer.statusCode, 403, preparer.body);
  assert.equal(preparer.json().permission, 'engagements.tax.reopen');
  assert.equal(preparer.json().message, 'This session does not hold engagements.tax.reopen.');
  const pointer = await reopen(done.id, brian, 'per ruling 67 as discussed');
  assert.equal(pointer.statusCode, 400, pointer.body);
  const tooShort = await reopen(done.id, brian, 'wrong ack');
  assert.equal(tooShort.statusCode, 400, tooShort.body);
  assert.equal((await state(done.id)).stage, 'completed', 'three refusals moved nothing');

  const open = await readyReturn('Notdone');
  assert.equal((await file(open.id)).statusCode, 200);
  const notCompleted = await reopen(open.id);
  assert.equal(notCompleted.statusCode, 409, notCompleted.body);
  assert.equal(notCompleted.json().error, 'not_completed');
});

test('the CEO reopens a completed return: back to filed with the reason, the engagement active again, the summary cleared, history and audits written, the executive count up by one', async () => {
  const te = await completedReturn('Reopened');
  const was = await state(te.id);
  assert.equal(was.engagement_status, 'completed', 'the acceptance closed the engagement');
  assert.ok(was.efile_accepted_at);
  const countBefore = await filedCount();

  const res = await reopen(te.id);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().stage, 'filed');
  assert.equal(res.json().engagementStatus, 'active');
  assert.deepEqual(res.json().jurisdictionsNeedingAnswer, ['federal']);

  const now = await state(te.id);
  assert.equal(now.stage, 'filed');
  assert.ok(now.reopened_at, 'when');
  assert.equal(now.reopen_reason, REASON, 'why');
  assert.equal(now.efile_accepted_at, null, 'nothing reads "the IRS said yes" about the filing in doubt');
  assert.equal(now.federal_accepted_on, null);
  assert.equal(now.engagement_status, 'active', 'the engagement returns to active');
  assert.equal(now.ended_on, null);
  assert.equal(await filedCount(), countBefore + 1, 'the executive view counts it as open again');

  const history = await app.db.query<{ stage: string; note: string | null }>(
    `SELECT stage::text AS stage, note FROM engagement_stage_history WHERE tax_engagement_id = $1 ORDER BY entered_at DESC LIMIT 1`, [te.id]);
  assert.equal(history.rows[0]!.stage, 'filed');
  assert.match(history.rows[0]!.note ?? '', /^reopened: /);
  const audit = await app.db.query<{ action: string; actor_label: string; details: Record<string, unknown> }>(
    `SELECT action, actor_label, details FROM audit_log WHERE action IN ('tax_engagement.reopened', 'engagement.reopened') AND (object_id = $1 OR object_id = $2) ORDER BY action`,
    [te.id, te.engagementId]);
  assert.deepEqual(audit.rows.map((r) => r.action), ['engagement.reopened', 'tax_engagement.reopened']);
  assert.equal(audit.rows[1]!.actor_label, brian.fullName, 'the actor is a name');
  assert.equal(audit.rows[1]!.details['reason'], REASON);
  assert.equal((audit.rows[1]!.details['previous'] as Record<string, unknown>)['federal_accepted_on'], today, 'what the summary said is kept on the audit row');

  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(brian) })).json() as {
    taxEngagement: { stage: string; reopened_at: string | null; reopen_reason: string | null };
    jurisdictions: Array<{ jurisdiction: string; acceptedOn: string | null; answerStale: boolean }>;
    jurisdictions_awaiting: string[]; activity: Array<{ action: string }>;
  };
  assert.equal(detail.taxEngagement.stage, 'filed');
  assert.equal(detail.taxEngagement.reopen_reason, REASON);
  assert.equal(detail.jurisdictions[0]!.answerStale, true, 'the acceptance that completed it is stale');
  assert.equal(detail.jurisdictions[0]!.acceptedOn, today, 'but still on the row as history');
  assert.deepEqual(detail.jurisdictions_awaiting, ['federal']);
  assert.ok(detail.activity.some((a) => a.action === 'tax_engagement.reopened'), 'the stepper reads the step');

  const again = await reopen(te.id);
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error, 'not_completed', 'a reopened return is filed, not completed');
});

test('re-completion is refused until a NEW acceptance after the reopen; the old acceptance does not count; the new one completes the return and closes the engagement again', async () => {
  const te = await completedReturn('Recomplete');
  assert.equal((await reopen(te.id)).statusCode, 200);

  const forced = await app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/transition`, headers: auth(brian), payload: { toStage: 'completed' } });
  assert.equal(forced.statusCode, 409, forced.body);
  assert.equal(forced.json().error, 'jurisdictions_awaiting');
  assert.match(forced.json().message, /Federal has not answered for this filing since it was reopened/);
  assert.equal((await state(te.id)).stage, 'filed', 'still filed');

  const reopenedAt = (await state(te.id)).reopened_at!;
  const fresh = await accept(te.id);
  assert.equal(fresh.statusCode, 200, fresh.body);
  assert.equal(fresh.json().stage, 'completed', 'a new acceptance completes it');
  const row = await app.db.query<{ accepted_on: string; answered_at: Date; reopened_at: Date }>(
    `SELECT accepted_on::text AS accepted_on, answered_at, reopened_at FROM tax_engagement_jurisdictions WHERE tax_engagement_id = $1 AND jurisdiction = 'federal'`, [te.id]);
  assert.equal(row.rows[0]!.accepted_on, today);
  assert.ok(row.rows[0]!.answered_at.getTime() > reopenedAt.getTime(), 'recorded after the reopen');
  const now = await state(te.id);
  assert.equal(now.stage, 'completed');
  assert.equal(now.engagement_status, 'completed', 'the engagement closes again');
  assert.ok(now.efile_accepted_at, 'and the summary reads the new acceptance');
});

test('a paper jurisdiction reopened takes a NEW mailing: the first mailing no longer answers, a second may be recorded, and the return completes on the last fresh answer', async () => {
  const te = await readyReturn('Papered');
  assert.equal((await file(te.id, { jurisdictions: ['federal', 'WI'], filingMethods: { WI: 'paper' } })).statusCode, 200);
  const mail = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/tax-engagements/${te.id}/jurisdictions/WI/mailing`, headers: auth(ana), payload: { mailedOn: today, method: 'first_class', ...payload } });
  assert.equal((await mail({})).statusCode, 200);
  assert.equal((await accept(te.id)).json().stage, 'completed');

  assert.equal((await reopen(te.id)).statusCode, 200);
  const detail = (await app.inject({ method: 'GET', url: `/tax-engagements/${te.id}`, headers: auth(brian) })).json() as {
    jurisdictions_awaiting: string[]; paper_awaiting_mailing: string[];
  };
  assert.deepEqual(detail.jurisdictions_awaiting, ['federal', 'WI'], 'both answers are in doubt');
  assert.deepEqual(detail.paper_awaiting_mailing, ['WI'], 'the paper row needs a Record mailing again');

  const second = await mail({ method: 'certified', trackingNumber: '9400SYNTHETIC0001' });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().stage, 'filed', 'WI answered; federal still awaited');
  assert.deepEqual(second.json().awaiting, ['federal']);
  const fresh = await accept(te.id);
  assert.equal(fresh.json().stage, 'completed', 'the last fresh answer completes it');
  assert.equal((await state(te.id)).engagement_status, 'completed');
});
