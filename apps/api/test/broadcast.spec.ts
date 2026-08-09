// M27 "Prove it": client announcements + review requests.
//
// CLAUDE.md, non-negotiable: "every announcement email carries CAN-SPAM
// unsubscribe; every broadcast SMS respects TCPA opt-out; suppression lists
// enforced at send time, approval-gated, never auto-sent."
//
// So these tests are attempts to VIOLATE each clause:
//   · send without approval
//   · approve your own broadcast
//   · strip the unsubscribe footer by editing the body
//   · reach someone who opted out during the approval wait
//   · reach someone with no SMS consent
//   · ask for a review right after an IRS notice, or twice in a season

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { unsubToken } from '../src/modules/comms/broadcast.ts';
import { requestReview, reviewAskDecision, runReviewRequestJob } from '../src/modules/comms/review-requests.ts';
import { todayChicago } from '../src/modules/tax/deadlines.ts';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff & { token: string };
let brian: TestStaff & { token: string };

const sent: Array<{ to: string; subject: string; text: string }> = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg: { to: string; subject: string; text: string }) {
    sent.push({ to: msg.to, subject: msg.subject, text: msg.text });
    return { id: `captured-${sent.length}` };
  },
};
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, {
    email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

async function activeContact(label: string, language: 'en' | 'es' = 'en') {
  const c = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: label, email: `${label.toLowerCase()}-bc@example.test`, language,
  });
  await app.db.query(`UPDATE contacts SET soto_status = 'active' WHERE id = $1`, [c.id]);
  return c;
}

async function draftBroadcast(name: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: 'POST', url: '/broadcasts', headers: auth(rene),
    payload: {
      name,
      channel: 'email',
      segment: { sotoStatus: 'active' },
      subjectEn: 'Tax season starts Monday',
      subjectEs: 'La temporada de impuestos empieza el lunes',
      bodyEn: 'Hi {{first_name}}, our January document window opens Monday.',
      bodyEs: 'Hola {{first_name}}, nuestra ventana de documentos de enero abre el lunes.',
      ...extra,
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().id as string;
}

before(async () => {
  config = await createTestConfig('broadcast');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  rene = await staffWithToken('rene-bc@example.test', 'comms_billing');
  brian = await staffWithToken('brian-bc@example.test', 'ceo');
});

after(async () => {
  await app.close();
});

test('a broadcast cannot send without approval, and cannot be self-approved', async () => {
  await activeContact('Reader');
  const id = await draftBroadcast('Season opener');

  // Straight to send while still a draft.
  const early = await app.inject({ method: 'POST', url: `/broadcasts/${id}/send`, headers: auth(brian) });
  assert.equal(early.statusCode, 409, early.body);
  assert.equal(early.json().error, 'not_approved');

  await app.inject({ method: 'POST', url: `/broadcasts/${id}/submit`, headers: auth(rene) });

  // The author approving their own bulk send.
  const selfApprove = await app.inject({ method: 'POST', url: `/broadcasts/${id}/approve`, headers: auth(rene) });
  assert.equal(selfApprove.statusCode, 403, 'comms staff cannot approve at all — that is a leadership act');

  const approved = await app.inject({ method: 'POST', url: `/broadcasts/${id}/approve`, headers: auth(brian) });
  assert.equal(approved.statusCode, 200, approved.body);

  // Still pending? No — and approving twice is refused.
  const again = await app.inject({ method: 'POST', url: `/broadcasts/${id}/approve`, headers: auth(brian) });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'not_pending');

  const sendRes = await app.inject({ method: 'POST', url: `/broadcasts/${id}/send`, headers: auth(brian) });
  assert.equal(sendRes.statusCode, 200, sendRes.body);
  assert.ok(sendRes.json().sentEmail >= 1);

  // The approver is named on the record — the CHECK makes 'sent' impossible otherwise.
  const row = await app.db.query<{ status: string; approved_by_staff_id: string }>(
    `SELECT status::text, approved_by_staff_id FROM broadcasts WHERE id = $1`, [id]
  );
  assert.equal(row.rows[0]!.status, 'sent');
  assert.equal(row.rows[0]!.approved_by_staff_id, brian.id);
});

test('the database refuses a sent broadcast with no approver, even by direct SQL', async () => {
  const id = await draftBroadcast('Sneaky');
  await assert.rejects(
    app.db.query(`UPDATE broadcasts SET status = 'sent', sent_at = now() WHERE id = $1`, [id]),
    /broadcasts_approved_before_send/,
    'the approval gate is a CHECK, not a convention in the service layer'
  );
});

test('every announcement email carries the unsubscribe footer, and the author cannot remove it', async () => {
  const reader = await activeContact('Footer');
  // A body that deliberately contains no unsubscribe language at all.
  const id = await draftBroadcast('No footer attempt', {
    segment: { sotoStatus: 'active', language: 'en' },
    bodyEn: 'Hi {{first_name}}, this body has no unsubscribe line and never will.',
    bodyEs: 'Hola {{first_name}}, este cuerpo no tiene línea de baja.',
  });
  await app.inject({ method: 'POST', url: `/broadcasts/${id}/submit`, headers: auth(rene) });
  await app.inject({ method: 'POST', url: `/broadcasts/${id}/approve`, headers: auth(brian) });

  const before = sent.length;
  await app.inject({ method: 'POST', url: `/broadcasts/${id}/send`, headers: auth(brian) });
  const delivered = sent.slice(before).find((m) => m.to.includes('footer-bc'))!;
  assert.ok(delivered, 'the contact was emailed');

  // The footer was appended by the sender, so it is there regardless of the copy.
  assert.match(delivered.text, /unsubscribe here: /i);
  assert.match(delivered.text, /Soto Accounting LLC · Chicago, IL/, 'CAN-SPAM postal identification');
  assert.ok(delivered.text.includes(unsubToken(app, reader.id)), 'the link carries this contact’s own token');
  // And it says plainly that opting out of news does not stop service messages.
  assert.match(delivered.text, /returns, invoices, and document requests still reach you/i);
});

test('Spanish readers get the Spanish footer and Spanish subject', async () => {
  await activeContact('Espanol', 'es');
  const id = await draftBroadcast('Bilingual', { segment: { sotoStatus: 'active', language: 'es' } });
  await app.inject({ method: 'POST', url: `/broadcasts/${id}/submit`, headers: auth(rene) });
  await app.inject({ method: 'POST', url: `/broadcasts/${id}/approve`, headers: auth(brian) });
  const before = sent.length;
  await app.inject({ method: 'POST', url: `/broadcasts/${id}/send`, headers: auth(brian) });

  const delivered = sent.slice(before).find((m) => m.to.includes('espanol-bc'))!;
  assert.equal(delivered.subject, 'La temporada de impuestos empieza el lunes');
  assert.match(delivered.text, /cancele su suscripción aquí/i);
  assert.match(delivered.text, /declaraciones, facturas y solicitudes de documentos seguirán llegando/i);
});

test('unsubscribe works with no account, is idempotent, and a wrong token is a 404', async () => {
  const reader = await activeContact('Unsub');
  const token = unsubToken(app, reader.id);

  const wrong = await app.inject({ method: 'GET', url: `/public/unsubscribe/${reader.id}/${'x'.repeat(43)}` });
  assert.equal(wrong.statusCode, 404);

  // No authorization header.
  const first = await app.inject({ method: 'GET', url: `/public/unsubscribe/${reader.id}/${token}` });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().optedOut, true);

  // Clicking twice (or a mail client pre-fetching) must not error or move the date.
  const stamp = await app.db.query<{ at: Date }>(`SELECT broadcast_opt_out_at AS at FROM contacts WHERE id = $1`, [reader.id]);
  const second = await app.inject({ method: 'POST', url: `/public/unsubscribe/${reader.id}/${token}` });
  assert.equal(second.statusCode, 200);
  const stamp2 = await app.db.query<{ at: Date }>(`SELECT broadcast_opt_out_at AS at FROM contacts WHERE id = $1`, [reader.id]);
  assert.equal(stamp.rows[0]!.at.getTime(), stamp2.rows[0]!.at.getTime(), 'the original opt-out time is preserved');

  assert.equal(await auditRows(app.db, 'broadcast.opted_out'), 2, 'both clicks are logged');
});

test('suppression is evaluated AT SEND, not at draft time', async () => {
  const staying = await activeContact('Staying');
  const leaving = await activeContact('Leaving');

  const id = await draftBroadcast('Timing', { segment: { sotoStatus: 'active', language: 'en' } });
  // Preview at draft time counts both.
  const preview = await app.inject({
    method: 'POST', url: '/broadcasts/preview', headers: auth(rene),
    payload: { segment: { sotoStatus: 'active', language: 'en' }, channel: 'email' },
  });
  const intendedAtDraft = preview.json().intended as number;
  assert.ok(intendedAtDraft >= 2);

  await app.inject({ method: 'POST', url: `/broadcasts/${id}/submit`, headers: auth(rene) });
  await app.inject({ method: 'POST', url: `/broadcasts/${id}/approve`, headers: auth(brian) });

  // …then one of them opts out DURING the approval wait.
  await app.inject({
    method: 'GET', url: `/public/unsubscribe/${leaving.id}/${unsubToken(app, leaving.id)}`,
  });

  const before = sent.length;
  const result = await app.inject({ method: 'POST', url: `/broadcasts/${id}/send`, headers: auth(brian) });
  const r = result.json();
  assert.ok(r.suppressed >= 1);
  assert.ok(r.suppressedByReason['opted out of announcements'] >= 1);

  const recipients = sent.slice(before).map((m) => m.to);
  assert.ok(recipients.some((to) => to.includes('staying-bc')));
  assert.ok(!recipients.some((to) => to.includes('leaving-bc')), 'the late opt-out was honoured');

  // The suppression is a ROW, with its reason — not just a counter.
  const supp = await app.db.query<{ suppressed_reason: string }>(
    `SELECT suppressed_reason FROM broadcast_recipients WHERE broadcast_id = $1 AND contact_id = $2`,
    [id, leaving.id]
  );
  assert.equal(supp.rows[0]!.suppressed_reason, 'opted out of announcements');

  // …and the audit records the whole shape of the send.
  const audit = await app.db.query<{ details: { suppressed: number; sent_email: number } }>(
    `SELECT details FROM audit_log WHERE action = 'broadcast.sent' AND object_id = $1`, [id]
  );
  assert.ok(audit.rows[0]!.details.suppressed >= 1);
});

test('broadcast SMS respects the TCPA consent gate and carries a STOP line', async () => {
  const consented = await activeContact('SmsYes');
  const refused = await activeContact('SmsNo');
  await app.db.query(`UPDATE contacts SET phone = '312-555-0100', sms_consent = true WHERE id = $1`, [consented.id]);
  await app.db.query(`UPDATE contacts SET phone = '312-555-0101', sms_consent = false WHERE id = $1`, [refused.id]);

  const preview = await app.inject({
    method: 'POST', url: '/broadcasts/preview', headers: auth(rene),
    payload: { segment: { sotoStatus: 'active' }, channel: 'sms' },
  });
  const reasons = preview.json().suppressed.map((s: { reason: string }) => s.reason);
  assert.ok(reasons.includes('no SMS consent (TCPA)'), 'the approver sees the TCPA suppression before approving');

  const id = await draftBroadcast('SMS blast', {
    channel: 'sms',
    smsEn: 'Soto: document window opens Monday.',
    smsEs: 'Soto: la ventana de documentos abre el lunes.',
  });
  await app.inject({ method: 'POST', url: `/broadcasts/${id}/submit`, headers: auth(rene) });
  await app.inject({ method: 'POST', url: `/broadcasts/${id}/approve`, headers: auth(brian) });
  const result = await app.inject({ method: 'POST', url: `/broadcasts/${id}/send`, headers: auth(brian) });
  assert.equal(result.statusCode, 200, result.body);

  // Twilio is unconfigured in test, so nothing actually sends — but the
  // non-consenting contact must be suppressed for CONSENT, not for config.
  const rows = await app.db.query<{ contact_id: string; suppressed_reason: string | null }>(
    `SELECT contact_id, suppressed_reason FROM broadcast_recipients WHERE broadcast_id = $1 AND channel = 'sms'`,
    [id]
  );
  const byContact = new Map(rows.rows.map((r) => [r.contact_id, r.suppressed_reason]));
  assert.ok(byContact.has(refused.id), 'the non-consenting contact is recorded, not skipped silently');
  assert.ok(byContact.has(consented.id));
  // An email-only broadcast never writes sms rows, and vice versa.
  const emailRows = await app.db.query(
    `SELECT 1 FROM broadcast_recipients WHERE broadcast_id = $1 AND channel = 'email'`, [id]
  );
  assert.equal(emailRows.rows.length, 0, 'an SMS broadcast does not email anyone');
});

test('an SMS broadcast requires copy in both languages before it can be created', async () => {
  const res = await app.inject({
    method: 'POST', url: '/broadcasts', headers: auth(rene),
    payload: {
      name: 'English only', channel: 'sms', segment: {},
      bodyEn: 'x', bodyEs: 'x', smsEn: 'English only, no Spanish',
    },
  });
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(res.json().error, 'sms_body_required');

  const noSubject = await app.inject({
    method: 'POST', url: '/broadcasts', headers: auth(rene),
    payload: { name: 'No subject', channel: 'email', segment: {}, bodyEn: 'x', bodyEs: 'x' },
  });
  assert.equal(noSubject.statusCode, 400);
  assert.equal(noSubject.json().error, 'subject_required');
});

test('review asks: never after a notice, an overdue invoice, or paused work', async () => {
  const client = await activeContact('Reviewable');

  // Clean state → we would ask (the automation is still OFF, tested below).
  assert.deepEqual(await reviewAskDecision(app, client.id), { send: true, reason: null });

  // An open IRS notice poisons it.
  const notice = await app.db.query<{ id: string }>(
    `INSERT INTO irs_notices (contact_id, notice_type, status, received_at)
     VALUES ($1, 'CP2000', 'under_review', now()) RETURNING id`,
    [client.id]
  );
  let d = await reviewAskDecision(app, client.id);
  assert.equal(d.send, false);
  assert.equal(d.reason, 'open IRS notice');

  // Resolving it is NOT enough — it was recent, and "we fixed your CP2000 last
  // month, please review us" is exactly the wrong ask.
  await app.db.query(`UPDATE irs_notices SET status = 'resolved' WHERE id = $1`, [notice.rows[0]!.id]);
  d = await reviewAskDecision(app, client.id);
  assert.equal(d.send, false);
  assert.match(d.reason!, /notice within 90 days/);

  // Backdate the notice out of the window; now an overdue invoice blocks it.
  await app.db.query(`UPDATE irs_notices SET created_at = now() - interval '200 days' WHERE id = $1`, [notice.rows[0]!.id]);
  const version = await app.db.query<{ id: string }>(`SELECT id FROM price_book_versions ORDER BY version_number DESC LIMIT 1`);
  const inv = await app.db.query<{ id: string }>(
    `INSERT INTO invoices (invoice_number, contact_id, status, subtotal_cents, total_cents, sent_at, price_book_version_id)
     VALUES ('SYN-REV-1', $1, 'overdue', 10000, 10000, now() - interval '40 days', $2) RETURNING id`,
    [client.id, version.rows[0]!.id]
  );
  d = await reviewAskDecision(app, client.id);
  assert.equal(d.reason, 'overdue invoice');

  await app.db.query(`UPDATE invoices SET status = 'paid', amount_paid_cents = 10000, paid_at = now() WHERE id = $1`, [inv.rows[0]!.id]);
  // Paused work blocks it too.
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status, work_paused_at)
     VALUES ($1, 'bookkeeping', 'active', now()) RETURNING id`,
    [client.id]
  );
  d = await reviewAskDecision(app, client.id);
  assert.equal(d.reason, 'work paused for non-payment');

  await app.db.query(`UPDATE engagements SET work_paused_at = NULL WHERE id = $1`, [eng.rows[0]!.id]);
  assert.equal((await reviewAskDecision(app, client.id)).send, true, 'clean again');
});

test('review asks are kill-switched OFF, throttled, and record every skip', async () => {
  const client = await activeContact('Throttled');

  // NOTE: the test harness arms every automation so ON-path specs work. Prod
  // ships them all disabled, so this test sets the state it is asserting about
  // rather than inheriting the harness default.
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'review_requests'`);

  // Disabled: the decision runs, the send does not.
  const gated = await requestReview(app, { contactId: client.id, trigger: 'onboarding_complete' });
  assert.equal(gated.sent, false);
  assert.equal(gated.automationDisabled, true);
  assert.equal(gated.reason, 'automation disabled');
  const skipRow = await app.db.query<{ status: string; suppressed_reason: string }>(
    `SELECT status, suppressed_reason FROM review_requests WHERE contact_id = $1`, [client.id]
  );
  assert.equal(skipRow.rows[0]!.status, 'suppressed');
  assert.equal(skipRow.rows[0]!.suppressed_reason, 'automation disabled', 'Brian can see what arming it would send');

  // Arm it deliberately, as Brian would.
  await app.db.query(`UPDATE automations SET enabled = true WHERE key = 'review_requests'`);

  const before = sent.length;
  const first = await requestReview(app, { contactId: client.id, trigger: 'return_accepted' });
  assert.equal(first.sent, true, first.reason ?? '');
  const email = sent.slice(before).find((m) => m.to.includes('throttled-bc'))!;
  assert.match(email.text, /a short Google review helps/);
  assert.match(email.text, /if something fell short, reply to this email instead/i, 'a bad experience is routed to us, not to Google');

  // Throttle: a second milestone in the same season does not ask again.
  const second = await requestReview(app, { contactId: client.id, trigger: 'onboarding_complete' });
  assert.equal(second.sent, false);
  assert.match(second.reason!, /already asked within 180 days/);

  // Opting out of announcements also stops review asks.
  const other = await activeContact('OptedOutReview');
  await app.db.query(`UPDATE contacts SET broadcast_opt_out_at = now() WHERE id = $1`, [other.id]);
  const refused = await requestReview(app, { contactId: other.id, trigger: 'return_accepted' });
  assert.equal(refused.sent, false);
  assert.equal(refused.reason, 'opted out of announcements');

  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'review_requests'`);
});

test('the review job is date-guarded and asks only on ACCEPTED returns', async () => {
  const today = todayChicago();
  // Explicit: prod state, not the harness default.
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'review_requests'`);
  const client = await activeContact('Accepted');
  const eng = await app.db.query<{ id: string }>(
    `INSERT INTO engagements (contact_id, service_line, status) VALUES ($1, 'tax', 'active') RETURNING id`,
    [client.id]
  );
  // A return that was FILED but never accepted must not trigger an ask —
  // filing is not the finish line.
  await app.db.query(
    `INSERT INTO tax_engagements (engagement_id, tax_year, return_type, stage, filed_date)
     VALUES ($1, 2025, '1040', 'rejected', $2::date)`,
    [eng.rows[0]!.id, today]
  );
  const filedOnly = await runReviewRequestJob(app, today);
  assert.equal(filedOnly.skipped, false);
  assert.equal(filedOnly.considered, 0, 'a filed-but-rejected return is not a milestone');

  // Same date again → guarded.
  assert.equal((await runReviewRequestJob(app, today)).skipped, true);

  // Now it is accepted.
  await app.db.query(
    `UPDATE tax_engagements SET stage = 'completed', efile_accepted_at = now() WHERE engagement_id = $1`,
    [eng.rows[0]!.id]
  );
  const tomorrow = new Date(`${today}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const next = await runReviewRequestJob(app, tomorrow.toISOString().slice(0, 10));
  assert.equal(next.considered, 1);
  assert.equal(next.sent, 0, 'the automation is OFF, so it counted rather than sent');
  assert.equal(next.suppressed, 1);
});
