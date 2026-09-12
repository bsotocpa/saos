/*
 * THE LIFECYCLE AND RETURN INVARIANTS (2026-09-12 evening, Brian's ruling 2).
 *
 *   2a. An engagement landing moves the contact to onboarding, at the database, and the event is
 *       audited; a contact holding open work cannot be set back to lead.
 *   2b. The intake opens no engagement; opening one by hand, or a return where no engagement
 *       exists, says why; a resolution case says why.
 *   2c. Withdrawing an engagement withdraws its unfiled returns, and the database refuses an
 *       engagement closing over one or a pre-filed return landing on a closed engagement.
 *
 * Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import type { AuthedStaff } from '../src/types.ts';
import { createEngagement } from '../src/modules/engagements/service.ts';
import { deriveLifecycle } from '../src/modules/crm/lifecycle.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const actorOf = (t: TestStaff): AuthedStaff => ({ id: t.id, email: t.email, fullName: t.fullName, roleKey: 'ceo', permissions: ['*'], sessionId: 'spec' });
const WHY = 'The client engaged by phone this morning; the quote follows tomorrow';

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-123456`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

before(async () => {
  config = await createTestConfig('lifecycle_inv');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-lifecycle@example.test', 'ceo');
  ana = await staffWithToken('ana-lifecycle@example.test', 'tax_preparer');
});
after(async () => { await app.close(); });

async function status(contactId: string): Promise<{ contact_status: string; soto_status: string }> {
  return (await app.db.query<{ contact_status: string; soto_status: string }>(`SELECT contact_status::text AS contact_status, soto_status::text AS soto_status FROM contacts WHERE id = $1`, [contactId])).rows[0]!;
}

/** A return opened by hand, with its engagement, through the route. */
async function openReturn(contactId: string, taxYear: number): Promise<{ teId: string; engagementId: string }> {
  const res = await app.inject({
    method: 'POST', url: '/tax-engagements', headers: auth(ana),
    payload: { contactId, taxYear, returnType: '1040', clientType: 'individual', reason: WHY },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { teId: res.json().id as string, engagementId: res.json().engagementId as string };
}

// ── 2a ──────────────────────────────────────────────────────────────────────────────────────
// ── 2a ──────────────────────────────────────────────────────────────────────────────────────

test('2a: an engagement landing moves a lead to onboarding at the database, audited as the event; open work cannot be set back to lead', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Lifecycle', email: 'lifecycle-lifecycle@example.test' });
  assert.equal((await status(c.id)).contact_status, 'lead');

  const before = (await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = 'contact.status_changed' AND contact_id = $1`, [c.id])).rows[0]!.n;
  await createEngagement(app, actorOf(brian), { contactId: c.id, serviceLine: 'bookkeeping', title: 'Books', status: 'active', periodKey: 'ongoing', origin: { via: 'staff', reason: WHY } }, {});
  const after = await status(c.id);
  assert.equal(after.contact_status, 'onboarding', 'open work means onboarding at least');
  assert.equal(after.soto_status, 'lead', 'the legacy mirror settled by the event');
  assert.equal(await deriveLifecycle(app, c.id), 'onboarding', 'the ladder says the same thing');

  const audit = await app.db.query<{ details: { from: string; to: string; because: string } }>(
    `SELECT details FROM audit_log WHERE action = 'contact.status_changed' AND contact_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [c.id]);
  assert.equal(Number((await app.db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = 'contact.status_changed' AND contact_id = $1`, [c.id])).rows[0]!.n), Number(before) + 1, 'the move is on the record once');
  assert.deepEqual(audit.rows[0]!.details, { from: 'lead', to: 'onboarding', because: 'engagement_created' });

  // The contrapositive, at the database: a contact holding open work is not a lead.
  await assert.rejects(
    app.db.query(`UPDATE contacts SET contact_status = 'lead' WHERE id = $1`, [c.id]),
    (e: { code?: string; message?: string }) => e.code === '23514' && /^lifecycle_contradiction:/.test(e.message ?? '')
  );
  // And the raw insert a migration or fixture makes is covered too: the trigger, not the service, moved it.
  const d = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Rawrow', email: 'rawrow-lifecycle@example.test' });
  await app.db.query(`INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'payroll', 'active')`, [d.id]);
  assert.equal((await status(d.id)).contact_status, 'onboarding', 'a raw insert moves it too');
});

// ── 2b ──────────────────────────────────────────────────────────────────────────────────────

test('2b: the intake opens no engagement; a hand-made engagement, return or resolution case says why', async () => {
  // The public form, end to end: a submission and a contact, and nothing agreed.
  const start = await app.inject({ method: 'POST', url: '/public/forms/soto_intake/start', payload: { language: 'en' } });
  assert.equal(start.statusCode, 201, start.body);
  const { submissionId, resumeToken } = start.json() as { submissionId: string; resumeToken: string };
  const submit = await app.inject({
    method: 'POST', url: `/public/forms/submissions/${submissionId}/submit`,
    payload: {
      resumeToken,
      answers: {
        language: 'en', first_name: 'Synthetic', last_name: 'Walkin', email: 'walkin-lifecycle@example.test',
        mobile_phone: '+13125550199', sms_ok: 'no', preferred_contact_method: 'email',
        owns_business: 'yes', business_name: 'Synthetic Walkin LLC', entity_type: 'llc', industry: 'food_beverage', years_in_business: '1-3', business_zip: '60608',
        services: ['tax_business', 'bookkeeping'], filed_last_year: 'yes', irs_letters: 'no', how_heard: 'google',
        communication_consent: true, esign_consent: true,
      },
    },
  });
  assert.equal(submit.statusCode, 200, submit.body);
  const c = (await app.db.query<{ id: string }>(`SELECT id FROM contacts WHERE email = 'walkin-lifecycle@example.test'`)).rows[0]!;
  assert.equal((await app.db.query(`SELECT 1 FROM engagements WHERE contact_id = $1`, [c.id])).rows.length, 0, 'the intake opens no engagement');
  assert.equal((await app.db.query(`SELECT 1 FROM tax_engagements te JOIN engagements e ON e.id = te.engagement_id WHERE e.contact_id = $1`, [c.id])).rows.length, 0, 'and no return');
  assert.equal((await status(c.id)).contact_status, 'lead', 'asking is not agreeing');

  // The manual door says why.
  const bare = await app.inject({ method: 'POST', url: '/engagements', headers: auth(brian), payload: { contactId: c.id, serviceLine: 'bookkeeping', status: 'active' } });
  assert.equal(bare.statusCode, 400, bare.body);
  const said = await app.inject({ method: 'POST', url: '/engagements', headers: auth(brian), payload: { contactId: c.id, serviceLine: 'bookkeeping', status: 'active', reason: WHY } });
  assert.equal(said.statusCode, 201, said.body);
  const origin = await app.db.query<{ details: { origin: string; reason: string } }>(`SELECT details FROM audit_log WHERE action = 'engagement.created' AND object_id = $1`, [said.json().id]);
  assert.equal(origin.rows[0]!.details.origin, 'staff');
  assert.equal(origin.rows[0]!.details.reason, WHY);

  // A return with no engagement for the year: refused without a reason, opened with one, and never twice.
  const noWhy = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(ana), payload: { contactId: c.id, taxYear: 2025, returnType: '1040', clientType: 'individual' } });
  assert.equal(noWhy.statusCode, 409, noWhy.body);
  assert.equal(noWhy.json().error, 'no_engagement_for_year');
  const opened = await openReturn(c.id, 2025);
  const again = await app.inject({ method: 'POST', url: '/tax-engagements', headers: auth(ana), payload: { contactId: c.id, taxYear: 2025, returnType: '1040', clientType: 'individual', reason: WHY } });
  assert.equal(again.statusCode, 409, again.body);
  assert.equal(again.json().error, 'return_exists');
  const te = await app.db.query<{ engagement_id: string }>(`SELECT engagement_id FROM tax_engagements WHERE id = $1`, [opened.teId]);
  assert.equal(te.rows[0]!.engagement_id, opened.engagementId);

  // A resolution case opens engagements outside acceptance and says why.
  const r = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Behind', email: 'behind-lifecycle@example.test' });
  const noCase = await app.inject({ method: 'POST', url: '/resolution/cases', headers: auth(ana), payload: { contactId: r.id, years: [{ taxYear: 2022, returnType: '1040' }] } });
  assert.equal(noCase.statusCode, 400, noCase.body);
  const withCase = await app.inject({ method: 'POST', url: '/resolution/cases', headers: auth(ana), payload: { contactId: r.id, years: [{ taxYear: 2022, returnType: '1040' }], reason: 'Unfiled years found at the first meeting; the client asked us to bring them current' } });
  assert.equal(withCase.statusCode, 201, withCase.body);
  const caseOrigin = await app.db.query<{ details: { origin: string; reason: string } }>(`SELECT details FROM audit_log WHERE action = 'engagement.created' AND contact_id = $1`, [r.id]);
  assert.ok(caseOrigin.rows.length >= 1);
  assert.equal(caseOrigin.rows[0]!.details.origin, 'resolution_case');
  assert.match(caseOrigin.rows[0]!.details.reason, /^resolution case .*: Unfiled years/);
});

// ── 2c ──────────────────────────────────────────────────────────────────────────────────────

test('2c: withdrawing an engagement withdraws its unfiled returns, and the database holds the invariant both ways', async () => {
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Orphan', email: 'orphan-lifecycle@example.test' });
  const { teId, engagementId } = await openReturn(c.id, 2025);
  assert.equal((await app.db.query<{ stage: string }>(`SELECT stage::text AS stage FROM tax_engagements WHERE id = $1`, [teId])).rows[0]!.stage, 'intake_started');

  // THE ROUTE, the way a person withdraws: the return goes with the engagement, on the record.
  const withdrawn = await app.inject({
    method: 'POST', url: `/engagements/${engagementId}/close`, headers: auth(brian),
    payload: { outcome: 'withdrawn', reason: 'The client decided to stay with their current preparer this year' },
  });
  assert.equal(withdrawn.statusCode, 200, withdrawn.body);
  const te = await app.db.query<{ stage: string }>(`SELECT stage::text AS stage FROM tax_engagements WHERE id = $1`, [teId]);
  assert.equal(te.rows[0]!.stage, 'withdrawn', 'no return is left behind on a withdrawn engagement');
  const history = await app.db.query<{ stage: string; note: string; changed_by_staff_id: string | null }>(
    `SELECT stage::text AS stage, note, changed_by_staff_id FROM engagement_stage_history WHERE tax_engagement_id = $1 ORDER BY entered_at DESC LIMIT 1`, [teId]);
  assert.equal(history.rows[0]!.stage, 'withdrawn');
  assert.match(history.rows[0]!.note, /^engagement withdrawn: The client decided/);
  assert.equal(history.rows[0]!.changed_by_staff_id, brian.id, 'the person who withdrew it is named');
  const audit = await app.db.query<{ details: { returns_withdrawn: string[] } }>(`SELECT details FROM audit_log WHERE action = 'engagement.closed' AND object_id = $1`, [engagementId]);
  assert.deepEqual(audit.rows[0]!.details.returns_withdrawn, [teId]);
  assert.equal((await status(c.id)).contact_status, 'dormant', 'the last engagement closing moves the contact down');

  // THE INVARIANT, at the database, both directions.
  await assert.rejects(
    app.db.query(`UPDATE tax_engagements SET stage = 'intake_started' WHERE id = $1`, [teId]),
    (e: { code?: string; message?: string }) => e.code === '23514' && /^return_without_engagement:/.test(e.message ?? ''),
    'a pre-filed return cannot sit on a withdrawn engagement'
  );
  const d = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Directsql', email: 'directsql-lifecycle@example.test' });
  const second = await openReturn(d.id, 2025);
  await assert.rejects(
    app.db.query(`UPDATE engagements SET status = 'withdrawn', close_reason = 'x' WHERE id = $1`, [second.engagementId]),
    (e: { code?: string; message?: string }) => e.code === '23514' && /^return_without_engagement:/.test(e.message ?? ''),
    'an engagement cannot close over an unfiled return'
  );
  await assert.rejects(
    app.db.query(`UPDATE engagements SET status = 'completed' WHERE id = $1`, [second.engagementId]),
    (e: { code?: string }) => e.code === '23514'
  );
  // A draft engagement holds no pre-filed return either: the ruling says active or on hold.
  const draft = await app.db.query<{ id: string }>(`INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'draft') RETURNING id`, [d.id]);
  await assert.rejects(
    app.db.query(`INSERT INTO tax_engagements (engagement_id, tax_year, return_type) VALUES ($1, 2024, '1040')`, [draft.rows[0]!.id]),
    (e: { code?: string; message?: string }) => e.code === '23514' && /^return_without_engagement:/.test(e.message ?? '')
  );
});
