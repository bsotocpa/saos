/*
 * THE SIGN-IN FOLLOWS THE CONTACT EMAIL, ONCE THE NEW ADDRESS CONFIRMS IT (Brian, 2026-09-26, R45).
 *
 *   "All client mail goes to the contact email. A new portal user is always created on the contact
 *    email. Changing the contact email while a portal user exists offers to move the sign-in with it.
 *    The move is confirmed by a link sent to the new address and audited."
 *
 * Proven here, against the routes: the PATCH offers; with the person's yes it records the pending
 * move and emails ONE link to the NEW address and nothing to the old; the client page reads the
 * pending move; nothing moves until the link's button is pressed (a POST — the R37 rule), which
 * moves portal_users.email and writes an audit row naming the field and no address; the link is
 * single use and expires; a resend retires the earlier link; a refused move (another account holds
 * the address) leaves the contact email unchanged; a role without contacts.write is refused; and the
 * magic link keeps going to the sign-in address until the move lands. Synthetic data only.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeContact, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let rene: TestStaff & { token: string };
let bookkeeper: TestStaff & { token: string };

const sent: MailMessage[] = [];
const capturingMailer: Mailer = {
  transport: 'console',
  async send(msg) { sent.push(msg); return { id: `captured-${sent.length}` }; },
};
const auth = (t: { token: string }) => ({ authorization: `Bearer ${t.token}` });
const mailTo = (email: string) => sent.filter((m) => m.to.toLowerCase() === email.toLowerCase());
const confirmToken = (mail: MailMessage): string => {
  const m = /\/auth\/confirm-email\?token=([A-Za-z0-9_-]+)/.exec(mail.text);
  assert.ok(m, `no confirmation link in:\n${mail.text}`);
  return m[1]!;
};

async function staffWithToken(email: string, role: string): Promise<TestStaff & { token: string }> {
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  const staff = await makeStaff(app.db, config, { email, name: `Synthetic ${role}`, role, password: `${role}-password-1234567`, totpSecret: secret });
  const code = new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: staff.password, totp: code } });
  assert.equal(res.statusCode, 200, res.body);
  return { ...staff, token: res.json().token as string };
}

/** A client with portal access on the contact email, the way 'Grant access' makes one. */
async function portalClient(tag: string): Promise<{ id: string; email: string; portalUserId: string }> {
  const email = `${tag}@example.test`;
  const c = await makeContact(app.db, { firstName: 'Synthetic', lastName: tag, email });
  const granted = await app.inject({ method: 'POST', url: '/portal-users', headers: auth(rene), payload: { contactId: c.id } });
  assert.equal(granted.statusCode, 201, granted.body);
  return { id: c.id, email, portalUserId: granted.json().id as string };
}
const signsInAs = async (portalUserId: string): Promise<string> =>
  (await app.db.query<{ email: string }>(`SELECT email FROM portal_users WHERE id = $1`, [portalUserId])).rows[0]!.email;

before(async () => {
  config = await createTestConfig('emailmove');
  app = buildServer(config, { mailer: capturingMailer });
  await app.ready();
  rene = await staffWithToken('rene-move@example.test', 'comms_billing');
  bookkeeper = await staffWithToken('books-move@example.test', 'bookkeeper');
});
after(async () => { await app.close(); });

test('a new portal user is created on the contact email', async () => {
  const c = await portalClient('created-on-contact');
  assert.equal(await signsInAs(c.portalUserId), c.email);
});

test('changing the contact email with a portal user OFFERS the move and moves nothing', async () => {
  const c = await portalClient('offer');
  sent.length = 0;
  const res = await app.inject({ method: 'PATCH', url: `/contacts/${c.id}`, headers: auth(rene), payload: { email: 'offer-new@example.test' } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().portalSignInMove, 'offered');
  assert.equal(await signsInAs(c.portalUserId), c.email, 'the sign-in did not move');
  assert.equal(mailTo('offer-new@example.test').length, 0, 'nothing was emailed: nobody accepted the offer');
  const contact = await app.db.query<{ email: string }>(`SELECT email FROM contacts WHERE id = $1`, [c.id]);
  assert.equal(contact.rows[0]!.email, 'offer-new@example.test', 'the contact email itself changed');

  // Declining the offer is recorded as such and still moves nothing.
  const declined = await app.inject({ method: 'PATCH', url: `/contacts/${c.id}`, headers: auth(rene), payload: { email: 'offer-newer@example.test', movePortalSignIn: false } });
  assert.equal(declined.json().portalSignInMove, 'declined');
  assert.equal(await signsInAs(c.portalUserId), c.email);

  // No portal user: nothing to offer.
  const plain = await makeContact(app.db, { firstName: 'Synthetic', lastName: 'Noportal', email: 'noportal@example.test' });
  const none = await app.inject({ method: 'PATCH', url: `/contacts/${plain.id}`, headers: auth(rene), payload: { email: 'noportal-2@example.test' } });
  assert.equal(none.json().portalSignInMove, 'not_applicable');
});

test('accepting the offer: one link to the NEW address, the pending move on the record, the sign-in unchanged until the press', async () => {
  const c = await portalClient('accept');
  const newEmail = 'accept-new@example.test';
  sent.length = 0;
  const res = await app.inject({ method: 'PATCH', url: `/contacts/${c.id}`, headers: auth(rene), payload: { email: newEmail, movePortalSignIn: true } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().portalSignInMove, 'pending_confirmation');

  assert.equal(mailTo(newEmail).length, 1, 'exactly one confirmation email, to the new address');
  assert.equal(mailTo(c.email).length, 0, 'nothing to the old address');
  const mail = mailTo(newEmail)[0]!;
  assert.match(mail.subject, /Confirm your new sign-in email/);
  assert.doesNotMatch(mail.text, /attorney|agreement|terms|liab/i, 'functional copy, no legal language');
  const token = confirmToken(mail);
  assert.equal(await signsInAs(c.portalUserId), c.email, 'the sign-in has NOT moved yet');

  // The client page reads the pending move.
  const page = await app.inject({ method: 'GET', url: `/contacts/${c.id}`, headers: auth(rene) });
  assert.equal(page.statusCode, 200, page.body);
  assert.equal(page.json().contact.portal_email_move_pending.new_email, newEmail);
  assert.equal(page.json().contact.portal_login_email, c.email);

  // Only a hash is stored.
  const stored = await app.db.query<{ token_hash: string; new_email: string }>(`SELECT token_hash, new_email FROM portal_email_changes WHERE portal_user_id = $1`, [c.portalUserId]);
  assert.equal(stored.rows.length, 1);
  assert.notEqual(stored.rows[0]!.token_hash, token);
  assert.equal(stored.rows[0]!.new_email, newEmail);

  // The request is audited by field, never by address.
  const requested = await app.db.query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = 'portal_user.email_move_requested' AND object_id = $1`, [c.portalUserId]
  );
  assert.equal(requested.rows.length, 1);
  assert.equal(requested.rows[0]!.details.field, 'email');
  assert.doesNotMatch(JSON.stringify(requested.rows[0]!.details), /@/, 'no address in the audit row');

  // Until the press, the magic link still answers the OLD address only: the new one has no account.
  sent.length = 0;
  await app.inject({ method: 'POST', url: '/portal/auth/magic/request', payload: { email: newEmail } });
  assert.equal(mailTo(newEmail).filter((m) => /auth\/verify/.test(m.text)).length, 0, 'no sign-in link goes to an address with no account');
  await app.inject({ method: 'POST', url: '/portal/auth/magic/request', payload: { email: c.email } });
  assert.equal(mailTo(c.email).filter((m) => /auth\/verify/.test(m.text)).length, 1, 'the sign-in address still gets its link');

  // THE PRESS: the POST moves the sign-in, once.
  const pressed = await app.inject({ method: 'POST', url: '/portal/auth/email-change/confirm', payload: { token } });
  assert.equal(pressed.statusCode, 200, pressed.body);
  assert.equal(pressed.json().moved, true);
  assert.equal(await signsInAs(c.portalUserId), newEmail, 'the sign-in is the contact email now');
  const moved = await app.db.query<{ details: Record<string, unknown>; actor_type: string }>(
    `SELECT details, actor_type FROM audit_log WHERE action = 'portal_user.email_moved' AND object_id = $1`, [c.portalUserId]
  );
  assert.equal(moved.rows.length, 1, 'the move is audited');
  assert.equal(moved.rows[0]!.details.field, 'email');
  assert.equal(moved.rows[0]!.details.source, 'contact.email');
  assert.doesNotMatch(JSON.stringify(moved.rows[0]!.details), /@/, 'field names only, never an address');

  // Single use.
  const again = await app.inject({ method: 'POST', url: '/portal/auth/email-change/confirm', payload: { token } });
  assert.equal(again.statusCode, 401);
  assert.equal(again.json().error, 'invalid_confirmation_link');

  // The pending move is gone from the client page, and the new address now signs in.
  const after = await app.inject({ method: 'GET', url: `/contacts/${c.id}`, headers: auth(rene) });
  assert.equal(after.json().contact.portal_email_move_pending, null);
  assert.equal(after.json().contact.portal_login_email, newEmail);
  sent.length = 0;
  await app.inject({ method: 'POST', url: '/portal/auth/magic/request', payload: { email: newEmail } });
  assert.equal(mailTo(newEmail).filter((m) => /auth\/verify/.test(m.text)).length, 1, 'the magic link follows the moved sign-in');
});

test('Resend retires the earlier link; an expired link is refused; a bookkeeper is refused', async () => {
  const c = await portalClient('resend');
  const newEmail = 'resend-new@example.test';
  sent.length = 0;
  await app.inject({ method: 'PATCH', url: `/contacts/${c.id}`, headers: auth(rene), payload: { email: newEmail, movePortalSignIn: true } });
  const first = confirmToken(mailTo(newEmail)[0]!);

  const forbidden = await app.inject({ method: 'POST', url: `/contacts/${c.id}/portal-email-move`, headers: auth(bookkeeper) });
  assert.equal(forbidden.statusCode, 403, 'no contacts.write, no resend');

  sent.length = 0;
  const resend = await app.inject({ method: 'POST', url: `/contacts/${c.id}/portal-email-move`, headers: auth(rene) });
  assert.equal(resend.statusCode, 200, resend.body);
  assert.equal(resend.json().resent, true);
  assert.equal(mailTo(newEmail).length, 1, 'one more link, to the new address');
  const second = confirmToken(mailTo(newEmail)[0]!);
  assert.notEqual(first, second);

  const stale = await app.inject({ method: 'POST', url: '/portal/auth/email-change/confirm', payload: { token: first } });
  assert.equal(stale.statusCode, 401, 'the superseded link is dead');
  assert.equal(await signsInAs(c.portalUserId), c.email);

  // Expiry: the live link, aged past its window.
  await app.db.query(`UPDATE portal_email_changes SET expires_at = now() - interval '1 minute' WHERE portal_user_id = $1 AND superseded_at IS NULL`, [c.portalUserId]);
  const expired = await app.inject({ method: 'POST', url: '/portal/auth/email-change/confirm', payload: { token: second } });
  assert.equal(expired.statusCode, 401);
  assert.equal(await signsInAs(c.portalUserId), c.email, 'nothing moved');
  const page = await app.inject({ method: 'GET', url: `/contacts/${c.id}`, headers: auth(rene) });
  assert.equal(page.json().contact.portal_email_move_pending, null, 'an expired move is no longer pending on the client page');
});

test('a refused move (another account signs in with the new address) leaves the contact email unchanged', async () => {
  const holder = await portalClient('holder');
  const c = await portalClient('refused');
  sent.length = 0;
  const res = await app.inject({ method: 'PATCH', url: `/contacts/${c.id}`, headers: auth(rene), payload: { email: holder.email, movePortalSignIn: true } });
  assert.equal(res.statusCode, 409, res.body);
  assert.equal(res.json().error, 'portal_email_taken');
  assert.equal(res.json().message, 'Another portal account already signs in with the contact email. Change one of the two addresses first.');
  const contact = await app.db.query<{ email: string }>(`SELECT email FROM contacts WHERE id = $1`, [c.id]);
  assert.equal(contact.rows[0]!.email, c.email, 'the email write rolled back with the refused move');
  assert.equal(sent.length, 0, 'nothing was emailed');
  assert.equal(await signsInAs(c.portalUserId), c.email);
});
