/*
 * MFA RECOVERY AND RESET (Brian, 2026-09-26, R65). Synthetic data only.
 *
 *   enrolment issues eight single-use recovery codes, shown once in the verify response, argon2-hashed
 *   in staff_mfa_recovery_codes, in no audit row;
 *   a recovery code signs in once in place of the authenticator and is consumed by the statement that
 *   accepts it; the CEO gets an mfa_recovery_used task and an Ops alert; a second use is refused and
 *   counts as a failed attempt;
 *   a new set from Account needs a current authenticator code and replaces the old set whole;
 *   Reset MFA (staff.mfa.reset, explicit-only, the CEO's) clears the authenticator and the codes with a
 *   reason, ends every session, is audited without the secret, emails the member, and the next sign-in
 *   lands on mfa_setup_required;
 *   role proof: comms_billing is refused 403 in the server's words.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import type { Mailer, MailMessage } from '../src/mailer.ts';
import { EXPLICIT_ONLY_PERMISSIONS } from '../src/plugins/auth.ts';
import { createTestConfig, makeStaff, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff;
let ceoToken = '';
const sent: MailMessage[] = [];
const CEO_TOTP = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const RENE_TOTP = new OTPAuth.Secret({ size: 20 }).base32;
const CODE_SHAPE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const totp = (secret: string) => new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate();
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

/** The member the whole file follows: created through POST /staff, enrolled through the real doors. */
const member = { id: '', email: 'recovering@example.test', display: 'Recovering Bookkeeper', password: 'recovering-own-password-2026', secret: '', codes: [] as string[], token: '' };

async function enrol(email: string, password: string): Promise<{ token: string; secret: string; codes: string[]; mustChangePassword: boolean }> {
  const first = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().status, 'mfa_setup_required');
  const setup = await app.inject({ method: 'POST', url: '/auth/mfa/setup', payload: { setupToken: first.json().setupToken } });
  assert.equal(setup.statusCode, 200, setup.body);
  const secret = setup.json().secret as string;
  const verified = await app.inject({ method: 'POST', url: '/auth/mfa/verify', payload: { setupToken: first.json().setupToken, code: totp(secret) } });
  assert.equal(verified.statusCode, 200, verified.body);
  const j = verified.json() as { token: string; recoveryCodes: string[]; mustChangePassword: boolean };
  return { token: j.token, secret, codes: j.recoveryCodes, mustChangePassword: j.mustChangePassword };
}

/** How many audit rows carry any of these codes, hyphenated or not, anywhere in their text. */
async function auditRowsNaming(codes: string[]): Promise<number> {
  const patterns = codes.flatMap((c) => [`%${c}%`, `%${c.replace('-', '')}%`]);
  const { rows } = await app.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log
      WHERE (details::text || ' ' || coalesce(actor_label, '') || ' ' || coalesce(object_id, '')) ILIKE ANY($1::text[])`,
    [patterns]
  );
  return Number(rows[0]!.n);
}

async function liveCodes(staffId: string): Promise<{ live: number; used: number }> {
  const { rows } = await app.db.query<{ live: string; used: string }>(
    `SELECT count(*) FILTER (WHERE used_at IS NULL)::text AS live, count(*) FILTER (WHERE used_at IS NOT NULL)::text AS used
       FROM staff_mfa_recovery_codes WHERE staff_id = $1`, [staffId]);
  return { live: Number(rows[0]!.live), used: Number(rows[0]!.used) };
}

before(async () => {
  config = await createTestConfig('mfa_recovery');
  const mailer: Mailer = { transport: 'console', async send(msg) { sent.push(msg); return { id: `t-${sent.length}` }; } };
  app = buildServer(config, { mailer });
  await app.ready();
  ceo = await makeStaff(app.db, config, { email: 'ceo-mfa@example.test', name: 'Synthetic CEO', role: 'ceo', password: 'ceo-password-12345678', totpSecret: CEO_TOTP });
  const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: ceo.email, password: ceo.password, totp: totp(CEO_TOTP) } });
  assert.equal(r.statusCode, 200, r.body);
  ceoToken = r.json().token;
});
after(async () => { await app.close(); });

test('enrolment issues eight recovery codes, once: in the verify response, argon2-hashed in the table, in no audit row', async () => {
  const created = await app.inject({
    method: 'POST', url: '/staff', headers: auth(ceoToken),
    payload: { email: member.email, legalName: 'Synthetic Recovering', displayName: member.display, roleKey: 'bookkeeper' },
  });
  assert.equal(created.statusCode, 201, created.body);
  const { id, tempPassword } = created.json() as { id: string; tempPassword: string };
  member.id = id;

  const e = await enrol(member.email, tempPassword);
  assert.equal(e.codes.length, 8, 'eight codes');
  for (const c of e.codes) assert.match(c, CODE_SHAPE, `code shape ${c}`);
  assert.equal(new Set(e.codes).size, 8, 'all distinct');
  assert.equal(e.mustChangePassword, true, 'a first sign-in still owes a password');
  member.codes = e.codes;
  member.secret = e.secret;

  const rows = await app.db.query<{ code_hash: string; used_at: Date | null }>(`SELECT code_hash, used_at FROM staff_mfa_recovery_codes WHERE staff_id = $1`, [id]);
  assert.equal(rows.rows.length, 8);
  for (const r of rows.rows) {
    assert.equal(r.used_at, null);
    assert.ok(r.code_hash.startsWith('$argon2'), 'hashed like a password');
    assert.ok(!e.codes.some((c) => r.code_hash.includes(c) || r.code_hash.includes(c.replace('-', ''))), 'no plaintext in the hash column');
  }
  const issued = await app.db.query<{ details: { count: number; on: string } }>(`SELECT details FROM audit_log WHERE action = 'auth.recovery_codes_issued' AND actor_id = $1`, [id]);
  assert.equal(issued.rows.length, 1);
  assert.deepEqual(issued.rows[0]!.details, { count: 8, on: 'enrolment' });
  assert.equal(await auditRowsNaming(e.codes), 0, 'no audit row carries a code');

  // The codes travel in that one response and nowhere else: a second verify is refused (MFA is on).
  const again = await app.inject({ method: 'POST', url: '/auth/mfa/setup', payload: { setupToken: 'stale' } });
  assert.equal(again.statusCode, 401);

  // Their own password, so later sign-ins have a credential (the temporary one is spent).
  const set = await app.inject({ method: 'POST', url: '/auth/password', headers: auth(e.token), payload: { currentPassword: tempPassword, newPassword: member.password } });
  assert.equal(set.statusCode, 200, set.body);
});

test('a recovery code signs in once and is consumed; the CEO gets the task and the alert; the same code is then refused as a failed attempt', async () => {
  const code = member.codes[0]!;
  const ok = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: member.email, password: member.password, recoveryCode: code } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().status, 'ok');
  assert.equal(ok.json().mustChangePassword, false);
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(ok.json().token) });
  assert.equal(me.statusCode, 200, 'a real session');
  assert.deepEqual(await liveCodes(member.id), { live: 7, used: 1 }, 'consumed in the same request');

  // The event is audited; the code is not.
  const used = await app.db.query<{ details: { codes_remaining: number } }>(`SELECT details FROM audit_log WHERE action = 'auth.recovery_code_used' AND actor_id = $1`, [member.id]);
  assert.equal(used.rows.length, 1);
  assert.equal(used.rows[0]!.details.codes_remaining, 7);
  const success = await app.db.query<{ details: { second_factor: string } }>(`SELECT details FROM audit_log WHERE action = 'auth.login_success' AND actor_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [member.id]);
  assert.equal(success.rows[0]!.details.second_factor, 'recovery_code');
  assert.equal(await auditRowsNaming(member.codes), 0, 'no audit row carries a code');

  // One task for the CEO and one Ops alert pointing at it; neither names the code.
  const tasks = await app.db.query<{ id: string; title: string; description: string; assigned_staff_id: string; source_id: string }>(
    `SELECT id, title, description, assigned_staff_id, source_id FROM tasks WHERE source_type = 'mfa_recovery_used'`);
  assert.equal(tasks.rows.length, 1, 'one task per use');
  const task = tasks.rows[0]!;
  assert.equal(task.assigned_staff_id, ceo.id, 'owned by the CEO');
  assert.equal(task.title, `${member.display} signed in with an MFA recovery code`);
  assert.ok(task.description.includes('7 of the set remain'), task.description);
  assert.ok(!member.codes.some((c) => task.description.includes(c) || task.title.includes(c)), 'the task names no code');
  const alerts = await app.inject({ method: 'GET', url: '/notifications', headers: auth(ceoToken) });
  const alert = (alerts.json().notifications as Array<{ type: string; severity: string; related_object_type: string; related_object_id: string; title: string }>)
    .find((n) => n.type === 'mfa_recovery_used');
  assert.ok(alert, 'the CEO has the alert');
  assert.equal(alert!.severity, 'critical');
  assert.equal(alert!.related_object_type, 'task');
  assert.equal(alert!.related_object_id, task.id);
  assert.ok(alert!.title.includes(member.display) && alert!.title.includes('7 left'), alert!.title);

  // The same code again: refused, counted, audited as a failed attempt.
  const before = await app.db.query<{ failed_login_count: number }>(`SELECT failed_login_count FROM staff WHERE id = $1`, [member.id]);
  const twice = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: member.email, password: member.password, recoveryCode: code } });
  assert.equal(twice.statusCode, 401, twice.body);
  assert.equal(twice.json().error, 'invalid_credentials');
  assert.equal(twice.json().message, 'The email, password or code did not match.');
  const afterRow = await app.db.query<{ failed_login_count: number }>(`SELECT failed_login_count FROM staff WHERE id = $1`, [member.id]);
  assert.equal(afterRow.rows[0]!.failed_login_count, before.rows[0]!.failed_login_count + 1, 'a wrong recovery code is a failed attempt');
  const failed = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'auth.login_failed' AND actor_id = $1 AND details->>'reason' = 'bad_recovery_code'`, [member.id]);
  assert.equal(failed.rows.length, 1);
  assert.deepEqual(await liveCodes(member.id), { live: 7, used: 1 }, 'nothing else consumed');

  // Typed by hand: lower case, the hyphen as a space. The second code is consumed by this.
  const loose = member.codes[1]!.toLowerCase().replace('-', ' ');
  const typed = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: member.email, password: member.password, recoveryCode: loose } });
  assert.equal(typed.statusCode, 200, typed.body);
  assert.deepEqual(await liveCodes(member.id), { live: 6, used: 2 });
  const tasksNow = await app.db.query(`SELECT 1 FROM tasks WHERE source_type = 'mfa_recovery_used'`);
  assert.equal(tasksNow.rows.length, 2, 'each use is its own task');

  // Both factors at once is refused at the door.
  const both = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: member.email, password: member.password, totp: totp(member.secret), recoveryCode: member.codes[2] } });
  assert.equal(both.statusCode, 400, both.body);
  assert.deepEqual(await liveCodes(member.id), { live: 6, used: 2 }, 'a refused body consumes nothing');
});

test('a new set from Account needs a current authenticator code, replaces the old set whole, and is audited', async () => {
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: member.email, password: member.password, totp: totp(member.secret) } });
  assert.equal(login.statusCode, 200, login.body);
  member.token = login.json().token;

  const wrongCode = totp(member.secret) === '000000' ? '111111' : '000000';
  const refused = await app.inject({ method: 'POST', url: '/auth/mfa/recovery-codes', headers: auth(member.token), payload: { code: wrongCode } });
  assert.equal(refused.statusCode, 401, refused.body);
  assert.equal(refused.json().error, 'invalid_totp');
  assert.deepEqual(await liveCodes(member.id), { live: 6, used: 2 }, 'a refused reissue changes nothing');

  const issued = await app.inject({ method: 'POST', url: '/auth/mfa/recovery-codes', headers: auth(member.token), payload: { code: totp(member.secret) } });
  assert.equal(issued.statusCode, 200, issued.body);
  const fresh = issued.json().recoveryCodes as string[];
  assert.equal(fresh.length, 8);
  for (const c of fresh) assert.match(c, CODE_SHAPE);
  assert.equal(fresh.filter((c) => member.codes.includes(c)).length, 0, 'a new set');
  assert.deepEqual(await liveCodes(member.id), { live: 8, used: 0 }, 'the old set, used and live, is gone');
  const reissue = await app.db.query<{ details: { count: number; on: string } }>(`SELECT details FROM audit_log WHERE action = 'auth.recovery_codes_issued' AND actor_id = $1 AND details->>'on' = 'reissue'`, [member.id]);
  assert.equal(reissue.rows.length, 1);
  assert.equal(reissue.rows[0]!.details.count, 8);
  assert.equal(await auditRowsNaming([...member.codes, ...fresh]), 0);

  // An old live code is dead; a new one signs in.
  const old = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: member.email, password: member.password, recoveryCode: member.codes[3] } });
  assert.equal(old.statusCode, 401, old.body);
  const now = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: member.email, password: member.password, recoveryCode: fresh[0] } });
  assert.equal(now.statusCode, 200, now.body);
  member.codes = fresh;
});

test('Reset MFA: the CEO clears the authenticator and the codes with a reason, sessions end, audited without the secret, the member is emailed, the next sign-in re-enrols', async () => {
  const url = `/staff/${member.id}/mfa/reset`;
  const short = await app.inject({ method: 'POST', url, headers: auth(ceoToken), payload: { reason: 'lost' } });
  assert.equal(short.statusCode, 400, 'a reason of ten characters or more');
  const artifact = await app.inject({ method: 'POST', url, headers: auth(ceoToken), payload: { reason: 'Phone lost, per ruling 3 this morning' } });
  assert.equal(artifact.statusCode, 400, 'a reason never cites a conversation');
  const missing = await app.inject({ method: 'POST', url: '/staff/00000000-0000-4000-8000-000000000000/mfa/reset', headers: auth(ceoToken), payload: { reason: 'Phone replaced; the old authenticator is gone.' } });
  assert.equal(missing.statusCode, 404);
  const enc = await app.db.query<{ hex: string; totp_enabled: boolean }>(`SELECT encode(totp_secret_enc, 'hex') AS hex, totp_enabled FROM staff WHERE id = $1`, [member.id]);
  assert.equal(enc.rows[0]!.totp_enabled, true, 'enrolled before the reset');
  const oldSecretHex = enc.rows[0]!.hex;
  const alive = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(member.token) });
  assert.equal(alive.statusCode, 200, 'the member has a live session before the reset');
  sent.length = 0;

  const reason = 'Phone replaced; the old authenticator is gone.';
  const reset = await app.inject({ method: 'POST', url, headers: auth(ceoToken), payload: { reason } });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(reset.json().status, 'ok');
  assert.equal(reset.json().emailed, true, 'the answer says the mail went');
  assert.ok(reset.json().sessionsRevoked >= 1, 'sessions ended');

  const after = await app.db.query<{ totp_enabled: boolean; totp_secret_enc: Buffer | null; password_hash: string }>(`SELECT totp_enabled, totp_secret_enc, password_hash FROM staff WHERE id = $1`, [member.id]);
  assert.equal(after.rows[0]!.totp_enabled, false);
  assert.equal(after.rows[0]!.totp_secret_enc, null, 'the secret is gone, not kept');
  assert.deepEqual(await liveCodes(member.id), { live: 0, used: 0 }, 'every recovery code cleared');
  const dead = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(member.token) });
  assert.equal(dead.statusCode, 401, 'the member is signed out everywhere');

  // Audited with the reason; the secret, in any form, is in no audit row.
  const audit = await app.db.query<{ actor_id: string; details: Record<string, unknown> }>(`SELECT actor_id, details FROM audit_log WHERE action = 'staff.mfa_reset' AND object_id = $1`, [member.id]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0]!.actor_id, ceo.id);
  assert.equal(audit.rows[0]!.details.reason, reason);
  assert.equal(audit.rows[0]!.details.was_enrolled, true);
  assert.equal(audit.rows[0]!.details.recovery_codes_cleared, 8, 'the whole set is cleared, the one used code included');
  assert.equal(audit.rows[0]!.details.emailed, true);
  const leak = await app.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_log WHERE details::text ILIKE ANY($1::text[])`,
    [[`%${member.secret}%`, `%${oldSecretHex}%`]]
  );
  assert.equal(Number(leak.rows[0]!.n), 0, 'the old secret is in no audit row');

  // Staff mail: the member is told, in words that carry no secret.
  assert.equal(sent.length, 1, 'one email');
  assert.equal(sent[0]!.to, member.email);
  assert.equal(sent[0]!.subject, 'Your SAOS sign-in: MFA was reset');
  assert.ok(sent[0]!.text.includes(member.display) && sent[0]!.text.includes(ceo.fullName), sent[0]!.text);
  assert.ok(/enrol a new authenticator/.test(sent[0]!.text), 'says to enrol again at next sign-in');
  assert.ok(!sent[0]!.text.includes(member.secret) && !member.codes.some((c) => sent[0]!.text.includes(c)), 'no secret, no code');
  const mailAudit = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'email.sent' AND object_id = 'staff_mfa_reset'`);
  assert.equal(mailAudit.rows.length, 1);

  // The password is untouched, and the next sign-in lands on enrolment with a new secret and a new set.
  const next = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: member.email, password: member.password } });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal(next.json().status, 'mfa_setup_required');
  const e = await enrol(member.email, member.password);
  assert.notEqual(e.secret, member.secret, 'a new authenticator secret');
  assert.equal(e.codes.length, 8);
  assert.equal(e.codes.filter((c) => member.codes.includes(c)).length, 0, 'a new set of codes');
  assert.equal(e.mustChangePassword, false, 'a reset does not spend the password');
  member.secret = e.secret;
  member.codes = e.codes;
  member.token = e.token;
});

test('role proof: staff.mfa.reset is explicit-only and seeded to the CEO alone; comms_billing is refused 403 in the server\'s words; the CEO may reset their own', async () => {
  assert.ok(EXPLICIT_ONLY_PERMISSIONS.has('staff.mfa.reset'), 'the wildcard does not reach it');
  const holders = await app.db.query<{ key: string }>(
    `SELECT r.key FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission = 'staff.mfa.reset' ORDER BY 1`);
  assert.deepEqual(holders.rows.map((r) => r.key), ['ceo']);

  const rene = await makeStaff(app.db, config, { email: 'rene-mfa@example.test', name: 'Synthetic Rene', role: 'comms_billing', password: 'comms_billing-password-1234', totpSecret: RENE_TOTP });
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: rene.email, password: rene.password, totp: totp(RENE_TOTP) } });
  assert.equal(login.statusCode, 200, login.body);
  const refused = await app.inject({ method: 'POST', url: `/staff/${member.id}/mfa/reset`, headers: auth(login.json().token), payload: { reason: 'Phone replaced; the old authenticator is gone.' } });
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().error, 'forbidden');
  assert.equal(refused.json().permission, 'staff.mfa.reset');
  assert.equal(refused.json().message, 'This session does not hold staff.mfa.reset.');
  const still = await app.db.query<{ totp_enabled: boolean }>(`SELECT totp_enabled FROM staff WHERE id = $1`, [member.id]);
  assert.equal(still.rows[0]!.totp_enabled, true, 'nothing changed');
  const noAudit = await app.db.query(`SELECT 1 FROM audit_log WHERE action = 'staff.mfa_reset' AND actor_id = $1`, [rene.id]);
  assert.equal(noAudit.rows.length, 0);

  // The CEO's own row is a row like any other: the reset lands and ends this very session.
  const self = await app.inject({ method: 'POST', url: `/staff/${ceo.id}/mfa/reset`, headers: auth(ceoToken), payload: { reason: 'Authenticator moved to a new phone; re-enrolling.' } });
  assert.equal(self.statusCode, 200, self.body);
  const gone = await app.inject({ method: 'GET', url: '/auth/me', headers: auth(ceoToken) });
  assert.equal(gone.statusCode, 401, 'the CEO is signed out too');
  const next = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: ceo.email, password: ceo.password } });
  assert.equal(next.json().status, 'mfa_setup_required');
});
