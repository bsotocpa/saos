// M5 "Prove it": magic-link e2e via a capturing mail transport, single-use +
// expiry semantics, row-level isolation (cross-client access fails closed),
// bounce → Rene task, and the placeholder send-gate. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { sendTemplatedEmail } from '../src/modules/templates/service.ts';
import { createTestConfig, makeContact, makeStaff, auditRows } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let reneToken: string;

const sentMail: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) {
    sentMail.push(msg);
    return { id: `captured-${sentMail.length}` };
  },
};

function lastMailTo(email: string): MailMessage {
  const msg = [...sentMail].reverse().find((m) => m.to === email);
  assert.ok(msg, `no captured mail to ${email}`);
  return msg;
}

function extractToken(mail: MailMessage): string {
  const match = mail.text.match(/token=([A-Za-z0-9_-]+)/);
  assert.ok(match, `no token link in mail body:\n${mail.text}`);
  return match[1]!;
}

async function grantAccess(contactId: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/portal-users',
    headers: { authorization: `Bearer ${reneToken}` },
    payload: { contactId },
  });
  assert.ok([200, 201].includes(res.statusCode), res.body);
}

async function clientSession(email: string): Promise<string> {
  const token = extractToken(lastMailTo(email));
  const res = await app.inject({ method: 'POST', url: '/portal/auth/magic/verify', payload: { token } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

before(async () => {
  config = await createTestConfig('portal');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();

  // Rene (comms_billing) drives portal access grants; uses the staff-auth path
  // from M4 with a pre-enrolled TOTP secret.
  const OTPAuth = await import('otpauth');
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const rene = await makeStaff(app.db, config, {
    email: 'rene@example.test',
    name: 'Synthetic Rene',
    role: 'comms_billing',
    password: 'rene-password-123456',
    totpSecret: secret,
  });
  const code = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: rene.email, password: rene.password, totp: code },
  });
  assert.equal(login.statusCode, 200, login.body);
  reneToken = login.json().token as string;
});

after(async () => {
  await app.close();
});

test('staff grants portal access → magic link email → client session (audited)', async () => {
  const ana = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'ClientA',
    email: 'client-a@example.test',
  });
  await grantAccess(ana.id);

  // FINDING #21: a FIRST grant sends the invitation, not a bare sign-in link. A brand
  // new client used to receive 'Here is your secure link to sign in to your Soto
  // Accounting portal' for a portal nobody had told them existed.
  const mail = lastMailTo(ana.email);
  assert.match(mail.subject, /portal is ready/i);
  assert.match(mail.text, /expires in 30 minutes/);
  assert.match(mail.text, /upload documents securely/i, 'it says what the portal is FOR');
  assert.match(mail.text, /send you a fresh one/i, 'and what to do when the link expires');

  const token = extractToken(mail);
  const verify = await app.inject({ method: 'POST', url: '/portal/auth/magic/verify', payload: { token } });
  assert.equal(verify.statusCode, 200, verify.body);
  assert.equal(verify.json().firstLogin, true);
  const session = verify.json().token as string;

  const me = await app.inject({
    method: 'GET',
    url: '/portal/me',
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().contact.email, ana.email);
  assert.ok((await auditRows(app.db, 'portal.login', ana.email)) >= 1);
  assert.ok((await auditRows(app.db, 'magic_link.issued')) >= 1);

  // Single use: redeeming the same link again fails.
  const replay = await app.inject({ method: 'POST', url: '/portal/auth/magic/verify', payload: { token } });
  assert.equal(replay.statusCode, 401);
});

test('spanish-language contact receives the spanish template', async () => {
  const luz = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'ClientEs',
    email: 'client-es@example.test',
    language: 'es',
  });
  await grantAccess(luz.id);
  const mail = lastMailTo(luz.email);
  assert.match(mail.subject, /enlace seguro/i);
  assert.match(mail.text, /funciona una sola vez/);
});

test('expired links are refused', async () => {
  const bea = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'ClientB',
    email: 'client-b@example.test',
  });
  await grantAccess(bea.id);
  const token = extractToken(lastMailTo(bea.email));
  await app.db.query(
    `UPDATE magic_link_tokens SET expires_at = now() - interval '1 minute'
     WHERE used_at IS NULL AND portal_user_id = (SELECT id FROM portal_users WHERE email = $1)`,
    [bea.email]
  );
  const res = await app.inject({ method: 'POST', url: '/portal/auth/magic/verify', payload: { token } });
  assert.equal(res.statusCode, 401);
});

test('requesting a link for an unknown email returns 200 and sends nothing (no enumeration)', async () => {
  const sentBefore = sentMail.length;
  const res = await app.inject({
    method: 'POST',
    url: '/portal/auth/magic/request',
    payload: { email: 'stranger@example.test' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(sentMail.length, sentBefore);
});

test('row-level isolation: a client can never see another client’s records', async () => {
  const alice = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'Alice',
    email: 'alice@example.test',
  });
  const bob = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'Bob',
    email: 'bob@example.test',
  });
  await grantAccess(alice.id);
  await grantAccess(bob.id);
  const aliceSession = await clientSession(alice.email);

  // A document that belongs to Bob only.
  await app.db.query(
    `INSERT INTO documents (contact_id, category, filename, minio_bucket, minio_key, uploaded_by_type)
     VALUES ($1, 'tax_documents', 'bob-w2.pdf', 'saos-documents', 'test/bob-w2.pdf', 'client')`,
    [bob.id]
  );

  const docs = await app.inject({
    method: 'GET',
    url: '/portal/documents',
    headers: { authorization: `Bearer ${aliceSession}` },
  });
  assert.equal(docs.statusCode, 200);
  assert.deepEqual(docs.json().documents, [], 'Alice must not see Bob’s documents');

  // Client-supplied ids do not influence scoping.
  const probe = await app.inject({
    method: 'GET',
    url: `/portal/documents?contactId=${bob.id}`,
    headers: { authorization: `Bearer ${aliceSession}` },
  });
  assert.deepEqual(probe.json().documents, []);

  // No token → fail closed.
  const anon = await app.inject({ method: 'GET', url: '/portal/documents' });
  assert.equal(anon.statusCode, 401);
});

test('logout revokes the portal session', async () => {
  const cara = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'Cara',
    email: 'cara@example.test',
  });
  await grantAccess(cara.id);
  const session = await clientSession(cara.email);

  const out = await app.inject({
    method: 'POST',
    url: '/portal/auth/logout',
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(out.statusCode, 200);
  const after = await app.inject({
    method: 'GET',
    url: '/portal/me',
    headers: { authorization: `Bearer ${session}` },
  });
  assert.equal(after.statusCode, 401);
});

test('bounce webhook creates the Rene verification task (and rejects bad secrets)', async () => {
  const dee = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'Dee',
    email: 'dee@example.test',
  });
  await grantAccess(dee.id);

  const badSecret = await app.inject({
    method: 'POST',
    url: '/webhooks/mail/delivery',
    headers: { 'x-webhook-secret': 'wrong-secret' },
    payload: { recipient: dee.email, event: 'bounce' },
  });
  assert.equal(badSecret.statusCode, 401);

  const res = await app.inject({
    method: 'POST',
    url: '/webhooks/mail/delivery',
    headers: { 'x-webhook-secret': config.WEBHOOK_SECRET },
    payload: { recipient: dee.email, event: 'bounce' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().matched, true);

  const task = await app.db.query(
    `SELECT t.title, t.assigned_staff_id, r.key AS role
     FROM tasks t
     LEFT JOIN staff s ON s.id = t.assigned_staff_id
     LEFT JOIN roles r ON r.id = s.role_id
     WHERE t.source_type = 'magic_link_bounce' AND t.contact_id = $1`,
    [dee.id]
  );
  assert.equal(task.rows.length, 1);
  assert.match(task.rows[0].title, /Magic link bounced/);
  assert.equal(task.rows[0].role, 'comms_billing', 'bounce task routes to Rene’s role');
  assert.ok((await auditRows(app.db, 'magic_link.bounced')) >= 1);
});

test('PLACEHOLDER GATE: placeholder templates are unsendable in every environment', async () => {
  const eve = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'Eve',
    email: 'eve@example.test',
  });
  const sentBefore = sentMail.length;
  await assert.rejects(
    sendTemplatedEmail(app, {
      to: eve.email,
      templateKey: 'engagement_letter_tax', // seeded with is_placeholder = true
      language: 'en',
      vars: { client_name: 'Synthetic Eve', service_scope: 'test', fee_summary: 'test' },
    }),
    (err: { code?: string }) => err.code === 'template_placeholder_blocked',
    'placeholder template must be refused'
  );
  assert.equal(sentMail.length, sentBefore, 'nothing may be sent when the gate fires');
});

// ── M21 hardening: httpOnly portal session cookie ───────────────────────────

test('magic verify sets an httpOnly cookie that authenticates; logout clears it', async () => {
  const finn = await makeContact(app.db, {
    firstName: 'Synthetic',
    lastName: 'Finn',
    email: 'finn@example.test',
  });
  await grantAccess(finn.id);

  const token = extractToken(lastMailTo(finn.email));
  const verify = await app.inject({ method: 'POST', url: '/portal/auth/magic/verify', payload: { token } });
  assert.equal(verify.statusCode, 200, verify.body);

  const cookie = verify.cookies.find((c) => c.name === 'saos_portal_session');
  assert.ok(cookie, 'verify must set the portal session cookie');
  assert.equal(cookie.httpOnly, true, 'cookie must be httpOnly — page JS never sees the token');
  assert.equal(cookie.sameSite?.toLowerCase(), 'lax');
  assert.equal(cookie.maxAge, config.PORTAL_SESSION_DAYS * 86400);

  // Cookie alone authenticates (no Authorization header)…
  const me = await app.inject({
    method: 'GET',
    url: '/portal/me',
    cookies: { saos_portal_session: cookie.value },
  });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().contact.email, finn.email);

  // …and logout via the cookie revokes the session and clears the cookie.
  const out = await app.inject({
    method: 'POST',
    url: '/portal/auth/logout',
    cookies: { saos_portal_session: cookie.value },
  });
  assert.equal(out.statusCode, 200, out.body);
  const cleared = out.cookies.find((c) => c.name === 'saos_portal_session');
  assert.ok(cleared);
  assert.equal(cleared.value, '');

  const replay = await app.inject({
    method: 'GET',
    url: '/portal/me',
    cookies: { saos_portal_session: cookie.value },
  });
  assert.equal(replay.statusCode, 401, 'revoked session must not authenticate even if the cookie is replayed');
});

/*
 * FINDING #21 (Brian, 2026-08-13): "No portal invite email exists. I received an invoice
 * link, clicked it, was asked to sign in, and had never been sent a way to set the portal
 * up; requesting a sign-in link produced no email either."
 *
 * Two separate defects behind one experience, and these cover both.
 */
test('#21: the first email is an INVITATION; the second is a bare sign-in link', async () => {
  const nueva = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Invitee', email: 'invitee@example.test',
  });
  await grantAccess(nueva.id);
  const invite = lastMailTo(nueva.email);
  assert.match(invite.subject, /portal is ready/i);

  // Granting again is not a second invitation — by now they know what the portal is.
  await grantAccess(nueva.id);
  const second = lastMailTo(nueva.email);
  assert.match(second.subject, /sign-in link/i, 'the re-send is the plain link');
  assert.doesNotMatch(second.text, /We have set up your secure client portal/);

  // Both are audited by purpose, so "did they ever get an invite" is answerable.
  const purposes = await app.db.query<{ purpose: string }>(
    `SELECT details->>'purpose' AS purpose FROM audit_log
      WHERE action = 'magic_link.issued' AND contact_id = $1 ORDER BY occurred_at`,
    [nueva.id]
  );
  assert.deepEqual(purposes.rows.map((r) => r.purpose), ['invite', 'login']);
});

test('#21: a KNOWN client who cannot sign in becomes a task — the answer to them is unchanged', async () => {
  // A contact we know, whose portal account is on a DIFFERENT address. Exactly Brian's
  // case: the invoice went to a +tagged address, he typed his base one.
  const known = await makeContact(app.db, {
    firstName: 'Synthetic', lastName: 'Mismatch', email: 'mismatch-base@example.test',
  });
  const sentBefore = sentMail.length;

  const res = await app.inject({
    method: 'POST', url: '/portal/auth/magic/request',
    payload: { email: 'mismatch-base@example.test' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(
    res.json().message,
    'If that address has portal access, a sign-in link is on its way.',
    'the client-facing answer does not change by a word — it must not confirm who is a client'
  );
  assert.equal(sentMail.length, sentBefore, 'and nothing is sent to an address with no account');

  // But we are no longer the only party unaware of it.
  const task = await app.db.query<{ title: string; description: string; contact_id: string }>(
    `SELECT title, description, contact_id FROM tasks
      WHERE source_type = 'portal_access_blocked' AND source_id = $1`,
    [known.id]
  );
  assert.equal(task.rows.length, 1, 'Rene gets a task naming the client');
  assert.match(task.rows[0]!.title, /could not/i);
  assert.match(task.rows[0]!.description, /no portal account yet/i);

  // A client retrying is one problem, not five.
  for (let i = 0; i < 3; i += 1) {
    await app.inject({
      method: 'POST', url: '/portal/auth/magic/request',
      payload: { email: 'mismatch-base@example.test' },
    });
  }
  const still = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'portal_access_blocked' AND source_id = $1`,
    [known.id]
  );
  assert.equal(still.rows[0]!.n, 1, 'deduped while open');
});

test('#21: an address we do not recognise creates NO task — the queue cannot be flooded', async () => {
  const before = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'portal_access_blocked'`
  );
  for (const email of ['nobody-1@example.test', 'nobody-2@example.test', 'nobody-3@example.test']) {
    const res = await app.inject({ method: 'POST', url: '/portal/auth/magic/request', payload: { email } });
    assert.equal(res.statusCode, 200);
  }
  const after = await app.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tasks WHERE source_type = 'portal_access_blocked'`
  );
  assert.equal(after.rows[0]!.n, before.rows[0]!.n, 'strangers produce a log line, not a task');
});

test('#21: the welcome email describes the checklist that actually exists', async () => {
  const { rows } = await app.db.query<{ body_en: string; body_es: string }>(
    `SELECT body_en, body_es FROM templates WHERE key = 'welcome_soto'`
  );
  const en = rows[0]!.body_en;
  // The portal redesign removed booking (a client only reaches this point AFTER the
  // discovery meeting) and replaced "last year's return" with documents generally.
  assert.doesNotMatch(en, /book your consultation/i, 'booking was removed from the checklist');
  assert.doesNotMatch(en, /4-step/i, 'and it is no longer four steps');
  assert.match(en, /pay your deposit/i, 'the deposit step is real and comes first');
  assert.doesNotMatch(rows[0]!.body_es, /reserve su consulta/i, 'the Spanish said it too');
});
