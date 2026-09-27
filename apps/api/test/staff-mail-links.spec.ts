/*
 * STAFF MAIL LINKS TO THE OPS SIGN-IN PAGE (Brian, 2026-09-27, R71). Synthetic data only.
 *
 *   Add staff and Regenerate each send the member one notice that a temporary password exists, who will
 *   hand it over, and the Ops sign-in link; the password itself is never in it;
 *   a recovery code used at sign-in sends the alert recipient (the CEO) a mail beside the task and the
 *   Ops alert, with the link and never the code;
 *   Reset MFA's mail carries the link, and nothing else in it changed;
 *   the link is OPS_URL + /login;
 *   a staff_mfa_reset row already on a box (the R65 text) takes the link through the ruled copy
 *   correction, gains the variable, and a second run touches nothing.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';
import { opsSignInUrl } from '../src/modules/staff/mail.ts';
// @ts-expect-error the seed module is plain JavaScript
import { applyRuledCopyCorrections } from '../../../packages/db/seeds/data/templates.mjs';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff;
let ceoToken = '';
const sent: MailMessage[] = [];
const CEO_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const totp = (secret: string) => new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const member = { id: '', email: 'mail-links@example.test', display: 'Links Bookkeeper' };
let signIn = '';

const mailsTo = (to: string, subject: string) => sent.filter((m) => m.to === to && m.subject === subject);

before(async () => {
  config = await createTestConfig('staff_mail_links');
  const mailer: Mailer = { transport: 'console', async send(msg) { sent.push(msg); return { id: `t-${sent.length}` }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  signIn = opsSignInUrl(app);
  ceo = await makeStaff(app.db, config, { email: 'ceo-links@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-12345678', totpSecret: CEO_TOTP });
  const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: ceo.email, password: ceo.password, totp: totp(CEO_TOTP) } });
  assert.equal(r.statusCode, 200, r.body);
  ceoToken = r.json().token;
});
after(async () => { await app.close(); });

test('the link is the Ops sign-in page: OPS_URL + /login', () => {
  assert.equal(signIn, new URL('/login', config.OPS_URL).toString());
  assert.match(signIn, /\/login$/);
});

test('Add staff and Regenerate: one notice each with the sign-in link, and never the password', async () => {
  const created = await app.inject({
    method: 'POST', url: '/staff', headers: auth(ceoToken),
    payload: { email: member.email, legalName: 'Synthetic Links Bookkeeper', displayName: member.display, roleKey: 'bookkeeper' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { id, tempPassword, emailed } = created.json() as { id: string; tempPassword: string; emailed: boolean };
  member.id = id;
  assert.equal(emailed, true, 'the answer says the notice went');
  const first = mailsTo(member.email, 'Your SAOS sign-in: a temporary password was issued');
  assert.equal(first.length, 1, 'one notice to the member');
  assert.ok(first[0]!.text!.includes(`Sign in here: ${signIn}`), 'the Ops sign-in link');
  assert.ok(first[0]!.text!.includes('Synthetic CEO will give it to you directly'), 'who hands it over');
  assert.ok(!first[0]!.text!.includes(tempPassword), 'the password is never in the mail');

  const again = await app.inject({ method: 'POST', url: `/staff/${member.id}/password/regenerate`, headers: auth(ceoToken) });
  assert.equal(again.statusCode, 200, again.body);
  const regenerated = again.json() as { tempPassword: string; emailed: boolean };
  assert.equal(regenerated.emailed, true);
  const both = mailsTo(member.email, 'Your SAOS sign-in: a temporary password was issued');
  assert.equal(both.length, 2, 'a second notice for the second password');
  assert.ok(both[1]!.text!.includes(`Sign in here: ${signIn}`));
  assert.ok(!both[1]!.text!.includes(regenerated.tempPassword), 'the new password is not in it either');
  assert.ok(!both[1]!.text!.includes(tempPassword));

  // The member enrols with the regenerated password, so the next test can use a recovery code.
  const first2 = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: member.email, password: regenerated.tempPassword } });
  assert.equal(first2.json().status, 'mfa_setup_required', first2.body);
  const setup = await app.inject({ method: 'POST', url: '/auth/mfa/setup', payload: { setupToken: first2.json().setupToken } });
  const secret = setup.json().secret as string;
  const verified = await app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { setupToken: first2.json().setupToken, code: totp(secret) } });
  assert.equal(verified.statusCode, 200, verified.body);
  const codes = verified.json().recoveryCodes as string[];
  // The owed password, so a later sign-in is a normal one.
  const own = 'links-bookkeeper-own-password-2026';
  const changed = await app.inject({
    method: 'POST', url: '/auth/password', headers: auth(verified.json().token),
    payload: { currentPassword: regenerated.tempPassword, newPassword: own },
  });
  assert.ok(changed.statusCode < 300, changed.body);

  // ── The recovery code: the CEO's mail, with the link and without the code.
  const before = sent.length;
  const withCode = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: member.email, password: own, recoveryCode: codes[0] } });
  assert.equal(withCode.statusCode, 200, withCode.body);
  const alert = sent.slice(before).filter((m) => m.subject === `SAOS alert: ${member.display} signed in with an MFA recovery code`);
  assert.equal(alert.length, 1, 'one alert mail');
  assert.equal(alert[0]!.to, ceo.email, 'to the alert recipient, the CEO');
  assert.ok(alert[0]!.text!.includes(`Sign in here: ${signIn}`));
  assert.ok(alert[0]!.text!.includes('7 of the set remain'), 'how many are left');
  for (const c of codes) assert.ok(!alert[0]!.text!.includes(c), 'no code in the mail');
  const task = await app.db.query(`SELECT 1 FROM tasks WHERE source_type = 'mfa_recovery_used' AND title = $1`, [`${member.display} signed in with an MFA recovery code`]);
  assert.equal(task.rowCount, 1, 'the task stands beside the mail');

  // ── Reset MFA: the link, and the R65 sentences around it unchanged.
  const reset = await app.inject({
    method: 'POST', url: `/staff/${member.id}/mfa/reset`, headers: auth(ceoToken),
    payload: { reason: 'Phone replaced; the old authenticator is gone.' },
  });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(reset.json().emailed, true);
  const resetMail = mailsTo(member.email, 'Your SAOS sign-in: MFA was reset');
  assert.equal(resetMail.length, 1);
  assert.ok(resetMail[0]!.text!.includes(
    `recovery codes. Your password is unchanged.\n\nSign in here: ${signIn}\n\nIf you did not expect this, speak to Synthetic CEO before signing in.`
  ), 'the link sits between the two R65 sentences, which are unchanged');
});

test('a staff_mfa_reset row carrying the R65 text takes the link through the ruled correction, once', async () => {
  // The row as R65 seeded it on the box: no link, no variable.
  await app.db.query(
    `UPDATE templates
        SET body_en = replace(body_en, $1, ''), body_es = replace(body_es, $2, ''),
            variables = variables - 'ops_signin_url'
      WHERE key = 'staff_mfa_reset'`,
    [`Sign in here: {{ops_signin_url}}\n\n`, `Inicie sesión aquí: {{ops_signin_url}}\n\n`]
  );
  const old = await app.db.query<{ body_en: string; version: number }>(`SELECT body_en, version FROM templates WHERE key = 'staff_mfa_reset'`);
  assert.ok(!old.rows[0]!.body_en.includes('{{ops_signin_url}}'), 'the R65 row has no link');

  const report = (await applyRuledCopyCorrections(app.db)) as string[];
  assert.ok(report.some((l) => l.startsWith('staff_mfa_reset: corrected')), report.join(' | '));
  const now = await app.db.query<{ body_en: string; body_es: string; version: number; variables: string[] }>(
    `SELECT body_en, body_es, version, variables FROM templates WHERE key = 'staff_mfa_reset'`);
  const row = now.rows[0]!;
  assert.ok(row.body_en.includes('Your password is unchanged.\n\nSign in here: {{ops_signin_url}}\n\nIf you did not expect this'));
  assert.ok(row.body_es.includes('Su contraseña no cambió.\n\nInicie sesión aquí: {{ops_signin_url}}\n\nSi no esperaba esto'));
  assert.ok(row.variables.includes('ops_signin_url'), 'the variable joins the row');
  assert.equal(row.version, old.rows[0]!.version + 1, 'version bumped once');
  const audit = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'template.updated' AND details->>'key' = 'staff_mfa_reset' AND details->>'ruling' LIKE 'R71%'`);
  assert.equal(audit.rowCount, 1, 'audited as the ruling');

  const second = (await applyRuledCopyCorrections(app.db)) as string[];
  assert.ok(second.some((l) => l.startsWith('staff_mfa_reset: nothing to correct')), second.join(' | '));
  const after2 = await app.db.query<{ version: number }>(`SELECT version FROM templates WHERE key = 'staff_mfa_reset'`);
  assert.equal(after2.rows[0]!.version, row.version, 'a second run touches nothing');
});
