// "Prove it": session recaps (v4.2 NEW MODULES #6).
//
// Spec: "a bilingual client recap is drafted and queued for Brian's one-tap
// approval before sending to the client's portal thread + email. Approval-gated,
// never auto-sent."
//
// "Never auto-sent" is the claim worth attacking, so these tests try to produce a
// sent recap without a human:
//   · approve without drafting
//   · reach 'sent' by direct SQL with no approver
//   · reach 'sent' with no send timestamp
//   · draft in one language only
// Plus: editing an approved recap withdraws the approval (Brian's name must not
// stay attached to text he has not read), and the automation toggle gates the SEND
// while still recording the approval.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let brian: TestStaff & { token: string };
let ana: TestStaff & { token: string };

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

/** A summarised session for a client, with decisions and action items. */
async function makeSession(label: string, opts: { language?: 'en' | 'es'; withClient?: boolean } = {}) {
  const contact = opts.withClient === false
    ? null
    : await makeContact(app.db, {
        firstName: 'Synthetic', lastName: label, email: `${label.toLowerCase()}-recap@example.test`,
        language: opts.language ?? 'en',
      });
  const meeting = await app.db.query<{ id: string }>(
    `INSERT INTO meetings (contact_id, title, type, source, status, started_at)
     VALUES ($1, $2, 'zoom', 'zoom_webhook', 'ready', now() - interval '2 hours') RETURNING id`,
    [contact?.id ?? null, `${label} monthly session`]
  );
  await app.db.query(
    `INSERT INTO meeting_summaries (meeting_id, model, summary, decisions, action_items)
     VALUES ($1, 'synthetic', $2, $3::jsonb, $4::jsonb)`,
    [
      meeting.rows[0]!.id,
      'Reviewed Q2 books and set the S-corp path for next year.',
      JSON.stringify(['Filed the 1040 for 2025', 'Agreed to elect S-corp for 2026']),
      JSON.stringify([
        { text: 'Send the June P&L', owner: 'client' },
        { text: 'Draft the 2553 election', owner: 'staff' },
      ]),
    ]
  );
  return { meetingId: meeting.rows[0]!.id, contactId: contact?.id ?? null };
}

before(async () => {
  config = await createTestConfig('recaps');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  brian = await staffWithToken('brian-recap@example.test', 'ceo');
  ana = await staffWithToken('ana-recap@example.test', 'tax_preparer');
  // Prod ships this OFF; the harness arms everything, so set it explicitly.
  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'session_recaps'`);
});

after(async () => {
  await app.close();
});

test('the draft is built from what the session produced, in both languages', async () => {
  const s = await makeSession('Drafted');
  const res = await app.inject({
    method: 'POST', url: `/meetings/${s.meetingId}/recap/draft`, headers: auth(ana),
  });
  assert.equal(res.statusCode, 200, res.body);
  const d = res.json();
  assert.equal(d.status, 'drafted');

  // All four spec sections, in both languages.
  for (const heading of ['What we covered', 'Your action items', 'What we are doing', 'Next session']) {
    assert.ok(d.bodyEn.includes(heading), `English missing "${heading}"`);
  }
  for (const heading of ['Lo que cubrimos', 'Sus tareas', 'Lo que haremos nosotros', 'Próxima sesión']) {
    assert.ok(d.bodyEs.includes(heading), `Spanish missing "${heading}"`);
  }

  // Real content from the session, not filler.
  assert.ok(d.bodyEn.includes('Agreed to elect S-corp for 2026'), 'decisions become "what we covered"');
  assert.ok(d.bodyEn.includes('Send the June P&L'), 'client-owned items become THEIR action items');
  assert.ok(d.bodyEn.includes('Draft the 2553 election'), 'staff-owned items become OURS');

  // No next session booked → says so honestly rather than inventing one.
  assert.ok(d.bodyEn.includes('No next session booked yet'));
  // The Spanish draft flags that it still needs Brian's pass.
  assert.match(d.bodyEs, /necesita su revisión/);

  // A session with no summary cannot be drafted from.
  const bare = await app.db.query<{ id: string }>(
    `INSERT INTO meetings (contact_id, title, type, source, status)
     VALUES ($1, 'Synthetic unsummarised', 'zoom', 'zoom_webhook', 'recorded') RETURNING id`,
    [s.contactId]
  );
  const nope = await app.inject({
    method: 'POST', url: `/meetings/${bare.rows[0]!.id}/recap/draft`, headers: auth(ana),
  });
  assert.equal(nope.statusCode, 404);
  assert.equal(nope.json().error, 'no_summary');
});

test('a real next session appears in the recap instead of the placeholder', async () => {
  const s = await makeSession('Booked');
  await app.db.query(
    `INSERT INTO client_sessions (contact_id, starts_at, status)
     VALUES ($1, now() + interval '30 days', 'scheduled')`,
    [s.contactId]
  );
  const res = await app.inject({
    method: 'POST', url: `/meetings/${s.meetingId}/recap/draft`, headers: auth(ana),
  });
  assert.ok(!res.json().bodyEn.includes('No next session booked yet'));
  assert.match(res.json().bodyEn, /## Next session\n\d{4}-\d{2}-\d{2}/, 'the real booking date');
});

test('NEVER AUTO-SENT: the database refuses a sent recap with no approver', async () => {
  const s = await makeSession('Gated');
  await app.inject({ method: 'POST', url: `/meetings/${s.meetingId}/recap/draft`, headers: auth(ana) });

  // Straight to sent, no approver — refused by CHECK, not by a service function.
  await assert.rejects(
    app.db.query(
      `UPDATE meeting_summaries SET client_recap_status = 'sent', recap_sent_at = now()
       WHERE meeting_id = $1`,
      [s.meetingId]
    ),
    /recap_approved_has_approver/,
    'reaching sent without a named approver is structurally impossible'
  );

  // Approved with no approver — same refusal.
  await assert.rejects(
    app.db.query(
      `UPDATE meeting_summaries SET client_recap_status = 'approved' WHERE meeting_id = $1`,
      [s.meetingId]
    ),
    /recap_approved_has_approver/
  );

  // Sent with an approver but no send timestamp — refused too, so "sent" always
  // has a time you can point at.
  await assert.rejects(
    app.db.query(
      `UPDATE meeting_summaries
       SET client_recap_status = 'sent', recap_approved_by_staff_id = $2, recap_approved_at = now()
       WHERE meeting_id = $1`,
      [s.meetingId, brian.id]
    ),
    /recap_sent_has_timestamp/
  );

  // And a draft cannot exist in one language only.
  await assert.rejects(
    app.db.query(
      `UPDATE meeting_summaries SET recap_body_es = NULL WHERE meeting_id = $1`,
      [s.meetingId]
    ),
    /recap_drafted_is_bilingual/,
    'a half-translated recap is a trap for whoever approves it'
  );
});

test('approving is leadership-only, and cannot happen before drafting', async () => {
  const s = await makeSession('Ordered');

  const early = await app.inject({
    method: 'POST', url: `/meetings/${s.meetingId}/recap/approve`, headers: auth(brian),
  });
  assert.equal(early.statusCode, 409, early.body);
  assert.equal(early.json().error, 'not_drafted');

  await app.inject({ method: 'POST', url: `/meetings/${s.meetingId}/recap/draft`, headers: auth(ana) });

  // A preparer can draft but not approve — "your voice, before it sends".
  const refused = await app.inject({
    method: 'POST', url: `/meetings/${s.meetingId}/recap/approve`, headers: auth(ana),
  });
  assert.equal(refused.statusCode, 403);
});

test('the toggle gates the SEND, and an approved-but-unsent recap explains itself', async () => {
  const s = await makeSession('Toggled');
  await app.inject({ method: 'POST', url: `/meetings/${s.meetingId}/recap/draft`, headers: auth(ana) });

  // Disarmed: the approval is still recorded (that is Brian's decision), the send
  // is not, and the reason is on the row.
  const before = sent.length;
  const gated = await app.inject({
    method: 'POST', url: `/meetings/${s.meetingId}/recap/approve`, headers: auth(brian),
  });
  assert.equal(gated.statusCode, 200, gated.body);
  assert.equal(gated.json().status, 'approved');
  assert.equal(gated.json().sent, false);
  assert.match(gated.json().suppressedReason, /automation is off/);
  assert.equal(sent.length, before, 'nothing was emailed');

  const row = await app.db.query<{
    status: string; approver: string | null; suppressed: string | null; message_id: string | null;
  }>(
    `SELECT client_recap_status::text AS status, recap_approved_by_staff_id AS approver,
            recap_send_suppressed_reason AS suppressed, recap_message_id AS message_id
     FROM meeting_summaries WHERE meeting_id = $1`,
    [s.meetingId]
  );
  assert.equal(row.rows[0]!.status, 'approved');
  assert.equal(row.rows[0]!.approver, brian.id, 'the approval is on the record regardless');
  assert.match(row.rows[0]!.suppressed!, /automation is off/);
  assert.equal(row.rows[0]!.message_id, null, 'and nothing was posted to the client thread');

  // The queue tells the UI the send is disarmed, so the button can say so.
  const queue = await app.inject({ method: 'GET', url: '/recaps', headers: auth(brian) });
  assert.equal(queue.json().automationArmed, false);
  assert.ok(queue.json().recaps.some((r: { meeting_id: string }) => r.meeting_id === s.meetingId));
});

test('armed: one tap posts to the portal thread and emails a pointer, in the client’s language', async () => {
  await app.db.query(`UPDATE automations SET enabled = true WHERE key = 'session_recaps'`);
  const s = await makeSession('Spanish', { language: 'es' });
  await app.inject({ method: 'POST', url: `/meetings/${s.meetingId}/recap/draft`, headers: auth(ana) });

  const before = sent.length;
  const res = await app.inject({
    method: 'POST', url: `/meetings/${s.meetingId}/recap/approve`, headers: auth(brian),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().status, 'sent');
  assert.equal(res.json().sent, true);
  assert.equal(res.json().emailed, true);

  // The recap itself is on the portal thread, in Spanish.
  const msg = await app.db.query<{ body: string; language: string; channel: string; template_key: string }>(
    `SELECT m.body, m.language, m.channel, m.template_key
     FROM messages m JOIN meeting_summaries ms ON ms.recap_message_id = m.id
     WHERE ms.meeting_id = $1`,
    [s.meetingId]
  );
  assert.equal(msg.rows[0]!.channel, 'portal');
  assert.equal(msg.rows[0]!.language, 'es');
  assert.ok(msg.rows[0]!.body.includes('Lo que cubrimos'), 'the Spanish body went to the thread');

  // The EMAIL is a short pointer, not a duplicate of the recap — replies belong
  // on the thread.
  const email = sent.slice(before).find((m) => m.to.includes('spanish-recap'))!;
  assert.match(email.subject, /resumen de su sesión/i);
  assert.match(email.text, /\/messages/, 'points at the portal thread');
  assert.ok(!email.text.includes('Lo que cubrimos'), 'the recap body is not duplicated into the email');

  // Sending twice is refused — the client has already read it.
  const again = await app.inject({
    method: 'POST', url: `/meetings/${s.meetingId}/recap/approve`, headers: auth(brian),
  });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'already_sent');

  // Re-drafting a sent recap is refused for the same reason.
  const redraft = await app.inject({
    method: 'POST', url: `/meetings/${s.meetingId}/recap/draft`, headers: auth(ana),
  });
  assert.equal(redraft.statusCode, 409);
  assert.equal(redraft.json().error, 'already_sent');

  await app.db.query(`UPDATE automations SET enabled = false WHERE key = 'session_recaps'`);
});

test('editing an approved recap withdraws the approval', async () => {
  const s = await makeSession('Edited');
  await app.inject({ method: 'POST', url: `/meetings/${s.meetingId}/recap/draft`, headers: auth(ana) });
  await app.inject({ method: 'POST', url: `/meetings/${s.meetingId}/recap/approve`, headers: auth(brian) });

  const approved = await app.db.query<{ status: string; approver: string | null }>(
    `SELECT client_recap_status::text AS status, recap_approved_by_staff_id AS approver
     FROM meeting_summaries WHERE meeting_id = $1`,
    [s.meetingId]
  );
  assert.equal(approved.rows[0]!.status, 'approved');

  const edit = await app.inject({
    method: 'PATCH', url: `/meetings/${s.meetingId}/recap`, headers: auth(brian),
    payload: { bodyEn: '## What we covered\n- Rewritten by hand before sending.' },
  });
  assert.equal(edit.statusCode, 200, edit.body);

  const after = await app.db.query<{ status: string; approver: string | null; body_en: string }>(
    `SELECT client_recap_status::text AS status, recap_approved_by_staff_id AS approver, recap_body_en AS body_en
     FROM meeting_summaries WHERE meeting_id = $1`,
    [s.meetingId]
  );
  assert.equal(after.rows[0]!.status, 'drafted', 'back to draft');
  assert.equal(after.rows[0]!.approver, null, 'Brian’s name does not stay on text he has not re-read');
  assert.match(after.rows[0]!.body_en, /Rewritten by hand/);
});

test('a session with no client cannot produce a recap', async () => {
  const s = await makeSession('Unlinked', { withClient: false });
  await app.inject({ method: 'POST', url: `/meetings/${s.meetingId}/recap/draft`, headers: auth(ana) });
  const res = await app.inject({
    method: 'POST', url: `/meetings/${s.meetingId}/recap/approve`, headers: auth(brian),
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'no_client');
});
