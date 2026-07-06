// M4 "Prove it": auth + MFA + lockout + RBAC integration tests with audit-row
// assertions, against a fresh migrated+seeded database. Synthetic data only.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as OTPAuth from 'otpauth';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.ts';
import { createTestConfig, makeStaff, auditRows, type TestStaff } from './helpers.ts';
import type { Config } from '../src/config.ts';

let app: FastifyInstance;
let config: Config;
let ceo: TestStaff;
let intern: TestStaff;

const CEO_TOTP_SECRET = new OTPAuth.Secret({ size: 20 }).base32;
const INTERN_TOTP_SECRET = new OTPAuth.Secret({ size: 20 }).base32;

function totpCode(secret: string): string {
  return new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
}

async function loginToken(staff: TestStaff): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: staff.email, password: staff.password, totp: totpCode(staff.totpSecret!) },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().token as string;
}

before(async () => {
  config = await createTestConfig('auth');
  app = buildServer(config);
  await app.ready();
  ceo = await makeStaff(app.db, config, {
    email: 'ceo@example.test',
    name: 'Synthetic CEO',
    role: 'ceo',
    password: 'correct-horse-battery-staple',
    totpSecret: CEO_TOTP_SECRET,
  });
  intern = await makeStaff(app.db, config, {
    email: 'intern@example.test',
    name: 'Synthetic Intern',
    role: 'intern',
    password: 'intern-password-123456',
    totpSecret: INTERN_TOTP_SECRET,
  });
});

after(async () => {
  await app.close();
});

test('health endpoint reports ok with db reachable', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: 'ok', db: 'ok' });
});

test('login with unknown email is a generic 401 (and audited)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'nobody@example.test', password: 'whatever-long-pass' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'invalid_credentials');
  assert.ok((await auditRows(app.db, 'auth.login_failed', 'nobody@example.test')) >= 1);
});

test('wrong password fails, wrong TOTP fails, correct pair logs in (all audited)', async () => {
  const bad = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: ceo.email, password: 'wrong-password-123' },
  });
  assert.equal(bad.statusCode, 401);
  assert.ok((await auditRows(app.db, 'auth.login_failed', ceo.email)) >= 1);

  const noTotp = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: ceo.email, password: ceo.password },
  });
  assert.equal(noTotp.statusCode, 401);
  assert.equal(noTotp.json().error, 'totp_required');

  const badTotp = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: ceo.email, password: ceo.password, totp: '000000' },
  });
  assert.equal(badTotp.statusCode, 401);

  const ok = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: ceo.email, password: ceo.password, totp: totpCode(CEO_TOTP_SECRET) },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().token);
  assert.ok((await auditRows(app.db, 'auth.login_success', ceo.email)) >= 1);

  const me = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${ok.json().token}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().role, 'ceo');
  assert.deepEqual(me.json().permissions, ['*']);
});

test('failed-login lockout engages at the limit and blocks even correct credentials', async () => {
  const victim = await makeStaff(app.db, config, {
    email: 'lockout@example.test',
    name: 'Synthetic Lockout',
    role: 'intern',
    password: 'lockout-password-123',
    totpSecret: new OTPAuth.Secret({ size: 20 }).base32,
  });

  for (let i = 0; i < config.LOGIN_MAX_ATTEMPTS - 1; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: victim.email, password: 'nope-nope-nope' },
    });
    assert.equal(res.statusCode, 401);
  }
  const locking = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: victim.email, password: 'nope-nope-nope' },
  });
  assert.equal(locking.statusCode, 423);
  assert.ok(locking.json().until);
  assert.equal(await auditRows(app.db, 'auth.locked_out', victim.email), 1);

  // Correct credentials are refused while locked.
  const during = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: victim.email, password: victim.password, totp: totpCode(victim.totpSecret!) },
  });
  assert.equal(during.statusCode, 423);
});

test('MFA is required: password-only account must enroll before receiving a session', async () => {
  const fresh = await makeStaff(app.db, config, {
    email: 'newhire@example.test',
    name: 'Synthetic Newhire',
    role: 'comms_billing',
    password: 'temp-password-for-newhire',
  });

  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: fresh.email, password: fresh.password },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().status, 'mfa_setup_required');
  const setupToken = login.json().setupToken as string;
  assert.ok(setupToken);

  // The scoped token is NOT a session.
  const sneak = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${setupToken}` },
  });
  assert.equal(sneak.statusCode, 401);

  const setup = await app.inject({ method: 'POST', url: '/auth/mfa/setup', payload: { setupToken } });
  assert.equal(setup.statusCode, 200, setup.body);
  const { secret, otpauthUri } = setup.json();
  assert.match(otpauthUri, /^otpauth:\/\/totp\//);

  const verify = await app.inject({
    method: 'POST',
    url: '/auth/mfa/verify',
    payload: { setupToken, code: totpCode(secret) },
  });
  assert.equal(verify.statusCode, 200, verify.body);
  const token = verify.json().token as string;
  assert.ok(token);
  assert.equal(await auditRows(app.db, 'auth.mfa_enrolled', fresh.email), 1);

  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.statusCode, 200);

  // Enrollment is one-shot: the same setup token cannot re-enroll.
  const again = await app.inject({
    method: 'POST',
    url: '/auth/mfa/setup',
    payload: { setupToken },
  });
  assert.equal(again.statusCode, 409);
});

test('sessions expire and logout revokes immediately', async () => {
  const token = await loginToken(ceo);

  // Force-expire it (simulating idle timeout) — then it must be refused.
  await app.db.query(
    `UPDATE staff_sessions SET expires_at = now() - interval '1 minute'
     WHERE id = (SELECT id FROM staff_sessions ORDER BY created_at DESC LIMIT 1)`
  );
  const expired = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(expired.statusCode, 401);

  const token2 = await loginToken(ceo);
  const out = await app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { authorization: `Bearer ${token2}` },
  });
  assert.equal(out.statusCode, 200);
  assert.ok((await auditRows(app.db, 'auth.logout', ceo.email)) >= 1);
  const afterLogout = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${token2}` },
  });
  assert.equal(afterLogout.statusCode, 401);
});

test('RBAC: intern is refused staff management; CEO is allowed; role change audits permission.change', async () => {
  const internToken = await loginToken(intern);
  const ceoToken = await loginToken(ceo);

  const refused = await app.inject({
    method: 'GET',
    url: '/staff',
    headers: { authorization: `Bearer ${internToken}` },
  });
  assert.equal(refused.statusCode, 403);

  const allowed = await app.inject({ method: 'GET', url: '/staff', headers: { authorization: `Bearer ${ceoToken}` } });
  assert.equal(allowed.statusCode, 200);
  assert.ok(Array.isArray(allowed.json().staff));

  const created = await app.inject({
    method: 'POST',
    url: '/staff',
    headers: { authorization: `Bearer ${ceoToken}` },
    payload: { email: 'promotee@example.test', fullName: 'Synthetic Promotee', roleKey: 'intern' },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.ok(created.json().tempPassword);
  const newId = created.json().id as string;
  assert.equal(await auditRows(app.db, 'staff.created', ceo.email), 1);

  const promoted = await app.inject({
    method: 'PATCH',
    url: `/staff/${newId}`,
    headers: { authorization: `Bearer ${ceoToken}` },
    payload: { roleKey: 'client_success' },
  });
  assert.equal(promoted.statusCode, 200, promoted.body);
  assert.equal(await auditRows(app.db, 'permission.change'), 1);
});

test('deactivating a staff member revokes their live sessions', async () => {
  const target = await makeStaff(app.db, config, {
    email: 'deactivate-me@example.test',
    name: 'Synthetic Leaver',
    role: 'intern',
    password: 'leaver-password-123',
    totpSecret: new OTPAuth.Secret({ size: 20 }).base32,
  });
  const targetToken = await loginToken(target);
  const ceoToken = await loginToken(ceo);

  const off = await app.inject({
    method: 'PATCH',
    url: `/staff/${target.id}`,
    headers: { authorization: `Bearer ${ceoToken}` },
    payload: { isActive: false },
  });
  assert.equal(off.statusCode, 200);
  assert.equal(await auditRows(app.db, 'staff.deactivated'), 1);

  const rejected = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${targetToken}` },
  });
  assert.equal(rejected.statusCode, 401);
});

test('password change requires the current password and revokes other sessions', async () => {
  const user = await makeStaff(app.db, config, {
    email: 'rotate@example.test',
    name: 'Synthetic Rotator',
    role: 'intern',
    password: 'original-password-123',
    totpSecret: new OTPAuth.Secret({ size: 20 }).base32,
  });
  const tokenA = await loginToken(user);
  const tokenB = await loginToken(user);

  const wrong = await app.inject({
    method: 'POST',
    url: '/auth/password',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { currentPassword: 'not-the-password', newPassword: 'brand-new-password-456' },
  });
  assert.equal(wrong.statusCode, 401);

  const ok = await app.inject({
    method: 'POST',
    url: '/auth/password',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: { currentPassword: user.password, newPassword: 'brand-new-password-456' },
  });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(await auditRows(app.db, 'auth.password_changed', user.email), 1);

  // The other session is dead; the changing session survives.
  const b = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${tokenB}` } });
  assert.equal(b.statusCode, 401);
  const a = await app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${tokenA}` } });
  assert.equal(a.statusCode, 200);
});

test('validation failures return sanitized issues (no echoed values)', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'not-an-email', password: '' },
  });
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, 'validation_failed');
  // Issues carry field paths and generic messages — never the submitted values.
  assert.ok(Array.isArray(body.issues));
  assert.ok(!JSON.stringify(body.issues).includes('not-an-email'));
});

// ── M21 hardening: httpOnly session cookie ─────────────────────────────────

test('login sets an httpOnly SameSite=Lax session cookie that authenticates on its own', async () => {
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: ceo.email, password: ceo.password, totp: totpCode(CEO_TOTP_SECRET) },
  });
  assert.equal(login.statusCode, 200, login.body);

  const cookie = login.cookies.find((c) => c.name === 'saos_staff_session');
  assert.ok(cookie, 'login must set the staff session cookie');
  assert.equal(cookie.httpOnly, true, 'cookie must be httpOnly — page JS never sees the token');
  assert.equal(cookie.sameSite?.toLowerCase(), 'lax');
  assert.equal(cookie.path, '/');
  assert.equal(cookie.maxAge, config.SESSION_ABSOLUTE_HOURS * 3600);

  // Cookie alone (no Authorization header) authenticates.
  const me = await app.inject({
    method: 'GET',
    url: '/auth/me',
    cookies: { saos_staff_session: cookie.value },
  });
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().email, ceo.email);

  // Logout via the cookie revokes the session AND clears the cookie.
  const out = await app.inject({
    method: 'POST',
    url: '/auth/logout',
    cookies: { saos_staff_session: cookie.value },
  });
  assert.equal(out.statusCode, 200, out.body);
  const cleared = out.cookies.find((c) => c.name === 'saos_staff_session');
  assert.ok(cleared, 'logout must clear the cookie');
  assert.equal(cleared.value, '');

  const afterLogout = await app.inject({
    method: 'GET',
    url: '/auth/me',
    cookies: { saos_staff_session: cookie.value },
  });
  assert.equal(afterLogout.statusCode, 401, 'revoked session must not authenticate even if the cookie is replayed');
});

test('a garbage session cookie is rejected', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/auth/me',
    cookies: { saos_staff_session: 'not-a-real-token' },
  });
  assert.equal(res.statusCode, 401);
});
