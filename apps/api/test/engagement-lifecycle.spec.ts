// #44 — CLOSING, HOLDING AND RESUMING an engagement.
//
// `completed`, `withdrawn` and `on_hold` were all in `engagement_status` from the first
// migration and NOTHING ever set any of them. An engagement went active and stayed active
// forever, which is why #42's `active → dormant` had to ride on the health sweep.
//
// The pause ruling is the interesting half — Brian's "who caused the pause owns the clock":
// a staff hold is our delay and is refunded to the client (waiting_since moves forward, the
// price lock extends); a dunning pause is theirs and is refunded to nobody. Same two
// columns, opposite consequences, which is why the source is recorded.
//
// ONE CLOCK (decision 6, 2026-09-09). The pause duration is measured by the database against
// the same now() that stamped work_paused_at (engagements/pause.ts). This spec backdates the
// pause with SQL and never reads Date.now(): the clock is frozen to Postgres on both sides, so
// six backdated days are six days on every run, on every host. calendar-dates.spec proves it
// five runs in a row.
//
// Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeContact, makeStaff, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { closeEngagement } from '../src/modules/engagements/close.ts';
import { pauseEngagement, resumeEngagement } from '../src/modules/engagements/pause.ts';
import { runLadderJob } from '../src/modules/tasks/service.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let intern: TestStaff & { token: string };

const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({
    method: 'POST', url: '/auth/login',
    payload: { email, password: staff.password, totp: code },
  });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

/** A signed-up client with one open engagement — genuinely `active` by the #42 ladder. */
async function activeClientWithEngagement(name: string): Promise<{ contactId: string; engagementId: string }> {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: name, email: `${name.toLowerCase()}@example.test`,
  });
  await app.db.query(
    `INSERT INTO engagement_packets (contact_id, master_template_key, master_version, schedule_codes, status, signed_at, signature_method)
     VALUES ($1, 'engagement_master', 1, ARRAY[]::text[], 'signed', now(), 'portal_esign')`,
    [c.id]
  );
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'bookkeeping', 'active', $2) RETURNING id`,
    [c.id, version.rows[0]!.id]
  );
  const { refreshContactStatus } = await import('../src/modules/crm/lifecycle.ts');
  await refreshContactStatus(app, c.id, 'test_fixture');
  return { contactId: c.id, engagementId: eng.rows[0]!.id };
}

const staffActor = (s: TestStaff) => ({ type: 'staff' as const, id: s.id, label: s.email });

async function statusOf(contactId: string): Promise<string> {
  const { rows } = await app.db.query<{ s: string }>(
    `SELECT contact_status::text AS s FROM contacts WHERE id = $1`, [contactId]
  );
  return rows[0]!.s;
}

before(async () => {
  config = await createTestConfig('englife');
  app = buildServer(config);
  await app.ready();
  brian = await staffWithToken('brian-englife@example.test', 'ceo');
  intern = await staffWithToken('intern-englife@example.test', 'intern');
});

after(async () => {
  await app.close();
});

// ── CLOSING ────────────────────────────────────────────────────────────────

test('closing is permission-gated, and the route is the same one a person clicks', async () => {
  const { engagementId } = await activeClientWithEngagement('Gated');

  const refused = await app.inject({
    method: 'POST', url: `/engagements/${engagementId}/close`, headers: auth(intern),
    payload: { outcome: 'completed' },
  });
  assert.equal(refused.statusCode, 403, 'engagements.write is not a permission an intern holds');

  const ok = await app.inject({
    method: 'POST', url: `/engagements/${engagementId}/close`, headers: auth(brian),
    payload: { outcome: 'completed', reason: 'Books delivered through December.' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().outcome, 'completed');
  assert.ok(await auditRows(app.db, 'engagement.closed', brian.email) >= 1, 'who closed it is recorded');
});

test('a second close is refused rather than overwriting the first', async () => {
  const { engagementId } = await activeClientWithEngagement('Twice');
  await closeEngagement(app, engagementId, { outcome: 'completed' }, staffActor(brian));

  const again = await app.inject({
    method: 'POST', url: `/engagements/${engagementId}/close`, headers: auth(brian),
    payload: { outcome: 'withdrawn', reason: 'changed my mind' },
  });
  assert.equal(again.statusCode, 409, 'a re-click cannot rewrite the outcome someone recorded');
  assert.match(again.json().message, /already closed/i);

  const row = await app.db.query<{ status: string }>(
    `SELECT status::text AS status FROM engagements WHERE id = $1`, [engagementId]
  );
  assert.equal(row.rows[0]!.status, 'completed', 'the first outcome stands');
});

test('withdrawing without a reason is refused — by the service AND by the database', async () => {
  const { engagementId } = await activeClientWithEngagement('Noreason');

  const res = await app.inject({
    method: 'POST', url: `/engagements/${engagementId}/close`, headers: auth(brian),
    payload: { outcome: 'withdrawn' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /reason/i);

  /*
   * The service refusing is a better error message, not the guarantee. Work that ended
   * without being delivered is the case someone has to explain a year later, so the
   * constraint is what actually holds — proven by going around the service entirely.
   */
  await assert.rejects(
    () => app.db.query(
      `UPDATE engagements SET status = 'withdrawn', ended_on = CURRENT_DATE WHERE id = $1`,
      [engagementId]
    ),
    /engagements_withdrawn_has_reason/,
    'the database refuses a reasonless withdrawal too'
  );
});

test('closing the last engagement moves the client to dormant; closing one of two does not', async () => {
  const { contactId, engagementId } = await activeClientWithEngagement('Lastone');
  const version = await app.db.query<{ id: string }>(
    `SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`
  );
  const second = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, price_book_version_id)
     VALUES ($1, 'payroll', 'active', $2) RETURNING id`,
    [contactId, version.rows[0]!.id]
  );
  const { refreshContactStatus } = await import('../src/modules/crm/lifecycle.ts');
  await refreshContactStatus(app, contactId, 'test');
  assert.equal(await statusOf(contactId), 'active');

  await closeEngagement(app, engagementId, { outcome: 'completed' }, staffActor(brian));
  assert.equal(await statusOf(contactId), 'active', 'one engagement still open — still a client');

  await closeEngagement(app, second.rows[0]!.id, { outcome: 'completed' }, staffActor(brian));
  assert.equal(await statusOf(contactId), 'dormant', 'the LAST one closing is what moves them');
});

// ── HOLDING ────────────────────────────────────────────────────────────────

test('a hold pauses the work and the client stays ACTIVE', async () => {
  const { contactId, engagementId } = await activeClientWithEngagement('Held');
  assert.equal(await statusOf(contactId), 'active');

  await pauseEngagement(app, engagementId, { reason: 'Waiting on the bank feed rebuild.' }, staffActor(brian));

  const row = await app.db.query<{ status: string; src: string; reason: string; by: string | null }>(
    `SELECT status::text AS status, work_pause_source AS src, work_pause_reason AS reason,
            work_paused_by_staff_id AS by
       FROM engagements WHERE id = $1`,
    [engagementId]
  );
  assert.equal(row.rows[0]!.status, 'on_hold');
  assert.equal(row.rows[0]!.src, 'staff', 'who caused it is recorded — it decides what resume does');
  assert.equal(row.rows[0]!.by, brian.id);

  /*
   * THE RULING: a pause is not an ending. A client whose work we deliberately held this
   * week has not stopped being a client, and reporting them `dormant` would be the system
   * telling us our own decision back as their disengagement.
   */
  assert.equal(await statusOf(contactId), 'active', 'the pause does not move the client');
});

test('the database refuses an on_hold engagement that is not actually paused', async () => {
  /*
   * "One pause mechanism, not two" (Brian). A status reading paused while the pause columns
   * sit empty would show as held on every screen and behave as running in every query.
   */
  const { engagementId } = await activeClientWithEngagement('Halfheld');
  await assert.rejects(
    () => app.db.query(`UPDATE engagements SET status = 'on_hold' WHERE id = $1`, [engagementId]),
    /engagements_on_hold_is_paused/,
    'on_hold IS the pause, enforced'
  );
});

test('resuming gives back the time: waiting_since moves forward and the price lock extends', async () => {
  const { contactId, engagementId } = await activeClientWithEngagement('Refunded');

  // A task waiting on this client for 10 days, and a price lock 20 days out.
  const task = await app.db.query<{ id: string }>(
    `INSERT INTO tasks (title, contact_id, engagement_id, status, waiting_since, client_visible)
     VALUES ('Synthetic: send the bank statements', $1, $2, 'waiting_for_input', now() - interval '10 days', true)
     RETURNING id`,
    [contactId, engagementId]
  );
  await app.db.query(
    `UPDATE engagements SET price_lock_expires_on = CURRENT_DATE + 20 WHERE id = $1`,
    [engagementId]
  );

  await pauseEngagement(app, engagementId, { reason: 'Our preparer is out.' }, staffActor(brian));
  // Backdate the pause so there is a duration to refund — 6 days of OUR delay.
  await app.db.query(
    `UPDATE engagements SET work_paused_at = now() - interval '6 days' WHERE id = $1`,
    [engagementId]
  );

  const result = await resumeEngagement(app, engagementId, staffActor(brian));
  assert.equal(result.pausedDays, 6);
  assert.equal(result.tasksAdjusted, 1);

  const after = await app.db.query<{ waiting_days: number; lock_days: number; status: string }>(
    `SELECT (EXTRACT(EPOCH FROM (now() - t.waiting_since)) / 86400)::int AS waiting_days,
            (e.price_lock_expires_on - CURRENT_DATE)::int AS lock_days,
            e.status::text AS status
       FROM tasks t JOIN engagements e ON e.id = t.engagement_id
      WHERE t.id = $1`,
    [task.rows[0]!.id]
  );
  assert.equal(after.rows[0]!.status, 'active', 'the engagement is running again');
  assert.equal(after.rows[0]!.waiting_days, 4, '10 days waited minus 6 days we held = 4 counted against them');
  assert.equal(after.rows[0]!.lock_days, 26, 'the price lock moved out by the same 6 days');
});

test('a dunning pause is NOT ours to refund, and staff cannot click through it', async () => {
  /*
   * The other half of the ruling: their delay, their clock. Suppress-only — nothing chases
   * them while it lasts, but no time is given back and the price lock does not move.
   */
  const { contactId, engagementId } = await activeClientWithEngagement('Overdue');
  await app.db.query(
    `UPDATE engagements
        SET work_paused_at = now() - interval '9 days',
            work_pause_reason = 'account needs attention',
            work_pause_source = 'dunning',
            price_lock_expires_on = CURRENT_DATE + 20
      WHERE id = $1`,
    [engagementId]
  );
  await app.db.query(
    `INSERT INTO tasks (title, contact_id, engagement_id, status, waiting_since, client_visible)
     VALUES ('Synthetic: send the bank statements', $1, $2, 'waiting_for_input', now() - interval '10 days', true)`,
    [contactId, engagementId]
  );

  const res = await app.inject({
    method: 'POST', url: `/engagements/${engagementId}/resume`, headers: auth(brian),
  });
  assert.equal(res.statusCode, 409, 'the billing hold is not lifted by clicking resume');
  assert.match(res.json().message, /non-payment/i);

  const still = await app.db.query<{ lock_days: number; waiting_days: number }>(
    `SELECT (e.price_lock_expires_on - CURRENT_DATE)::int AS lock_days,
            (SELECT (EXTRACT(EPOCH FROM (now() - t.waiting_since)) / 86400)::int
               FROM tasks t WHERE t.engagement_id = e.id LIMIT 1) AS waiting_days
       FROM engagements e WHERE e.id = $1`,
    [engagementId]
  );
  assert.equal(still.rows[0]!.lock_days, 20, 'their pause extends nothing');
  assert.equal(still.rows[0]!.waiting_days, 10, 'and refunds nothing — their clock kept running');
});

test('paying an invoice lifts a DUNNING pause but never a staff hold', async () => {
  /*
   * `resumeAfterPayment` used to clear whatever pause it found. Once staff can hold an
   * engagement through the same columns, that is an automatic action quietly reversing a
   * human decision — with an audit row crediting the payment for it.
   */
  const { contactId, engagementId } = await activeClientWithEngagement('Paidup');
  await pauseEngagement(app, engagementId, { reason: 'Scope question open with the client.' }, staffActor(brian));

  const inv = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (contact_id, engagement_id, invoice_number, status,
                           subtotal_cents, total_cents, amount_paid_cents, due_date, paid_at)
     VALUES ($1, $2, 'SYNTH-PAUSE-1', 'paid', 10000, 10000, 10000, CURRENT_DATE, now())
     RETURNING id`,
    [contactId, engagementId]
  );

  const { resumeAfterPayment } = await import('../src/modules/billing/dunning.ts');
  await resumeAfterPayment(app, inv.rows[0]!.id);

  const row = await app.db.query<{ status: string; src: string | null }>(
    `SELECT status::text AS status, work_pause_source AS src FROM engagements WHERE id = $1`,
    [engagementId]
  );
  assert.equal(row.rows[0]!.src, 'staff', 'the staff hold survived the payment');
  assert.equal(row.rows[0]!.status, 'on_hold');
});

// ── THE LADDER ─────────────────────────────────────────────────────────────

test('the escalation ladder does not chase a client whose work is paused, and says how many it held', async () => {
  /*
   * The ladder emails at D3 and texts at D7. Refunding `waiting_since` on resume does not
   * un-send a reminder that already went out, so "hold the clock" has to mean the ladder
   * skips the task while the pause is on — not merely that the days are given back later.
   */
  const { contactId, engagementId } = await activeClientWithEngagement('Unchased');
  await app.db.query(
    `INSERT INTO tasks (title, contact_id, engagement_id, status, waiting_since, client_visible)
     VALUES ('Synthetic: waiting 12 days', $1, $2, 'waiting_for_input', now() - interval '12 days', true)`,
    [contactId, engagementId]
  );
  await app.db.query(
    `UPDATE automations SET enabled = true WHERE key = 'escalation_ladder'`
  );

  await pauseEngagement(app, engagementId, { reason: 'Holding while we rescope.' }, staffActor(brian));

  const run = await runLadderJob(app, '2026-08-20');
  assert.ok((run.pausedHeld ?? 0) >= 1, 'the run record says one was held back, not that it was a quiet day');

  /*
   * Scoped to THIS client rather than asserting the whole run fired nothing. Other tests in
   * this file leave tasks waiting on unpaused engagements, and those SHOULD climb — an
   * assertion that passes only because the rest of the file happens to be quiet is a
   * property of the fixture, not of the code.
   */
  const fired = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE action = 'ladder.rung_fired' AND contact_id = $1`,
    [contactId]
  );
  assert.equal(fired.rows[0]!.n, 0, 'no rung was recorded against the paused client');

  // And the proof it would have climbed: 12 days waiting is past D7.
  const rung = await app.db.query<{ ladder_rung: number }>(
    `SELECT ladder_rung FROM tasks WHERE contact_id = $1`, [contactId]
  );
  assert.equal(rung.rows[0]!.ladder_rung, 0, 'the task sat at rung 0 through a run that would have moved it');
});

// ── THE COMPLIANCE GATE THE PAUSE COULD HAVE OPENED ────────────────────────

test('an ON HOLD bookkeeping engagement still blocks an attest engagement', async () => {
  /*
   * The gate that making `on_hold` real could have quietly opened. Independence is about
   * the RELATIONSHIP, not about whether we happen to be working this week — if the check
   * read only `active`, anyone could pause the bookkeeping for a day and create the audit
   * engagement without Brian's documented override. CLAUDE.md, non-negotiable.
   */
  const { contactId, engagementId } = await activeClientWithEngagement('Independent');
  await pauseEngagement(app, engagementId, { reason: 'Client asked us to hold for a month.' }, staffActor(brian));

  const res = await app.inject({
    method: 'POST', url: '/engagements', headers: auth(brian),
    payload: { contactId, serviceLine: 'attest' },
  });
  assert.equal(res.statusCode, 409, 'the paused bookkeeping engagement is still a conflict');
  assert.match(res.json().message, /independence/i);
});
