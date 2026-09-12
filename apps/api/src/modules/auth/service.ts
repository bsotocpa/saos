// Staff login flow (MP WISP: MFA required for all staff, failed-login
// lockout, session timeout; every outcome audit-logged).
//
// State machine:
//   password wrong ................ 'invalid' (+ failed count, lockout at max)
//   account locked ................ 'locked'
//   password ok, MFA not enrolled . 'mfa_setup_required' + scoped setup token
//                                   (NO full session exists until MFA is on)
//   password ok, MFA enrolled ..... TOTP required; wrong code counts as a
//                                   failed attempt; right code → session

import * as OTPAuth from 'otpauth';
import argon2 from 'argon2';
import type { Db } from '../../db.ts';
import type { Config } from '../../config.ts';
import { writeAudit } from '../../audit.ts';
import {
  createScopedToken,
  decryptSecret,
  encryptSecret,
  generateToken,
  verifyScopedToken,
} from '../../crypto.ts';
import { AppError } from '../../types.ts';

const MFA_SETUP_PURPOSE = 'mfa_setup';
const MFA_SETUP_TTL_SECONDS = 15 * 60;
const TOTP_ISSUER = 'SAOS';

export type LoginResult =
  | { status: 'invalid' }
  | { status: 'locked'; until: Date }
  | { status: 'totp_required' }
  | { status: 'temp_password_expired' }
  | { status: 'mfa_setup_required'; setupToken: string }
  | { status: 'ok'; token: string; staffId: string; mustChangePassword: boolean };

interface StaffAuthRow {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  password_hash: string | null;
  totp_secret_enc: Buffer | null;
  totp_enabled: boolean;
  temp_password_expires_at?: Date | null;
  must_change_password?: boolean;
  failed_login_count: number;
  locked_until: Date | null;
}

interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

function totpFor(secretBase32: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

async function recordFailure(db: Db, config: Config, staff: StaffAuthRow, reason: string, meta: RequestMeta): Promise<LoginResult> {
  const attempts = staff.failed_login_count + 1;
  if (attempts >= config.LOGIN_MAX_ATTEMPTS) {
    const { rows } = await db.query<{ locked_until: Date }>(
      `UPDATE staff
       SET failed_login_count = 0,
           locked_until = now() + make_interval(mins => $2)
       WHERE id = $1
       RETURNING locked_until`,
      [staff.id, config.LOGIN_LOCKOUT_MINUTES]
    );
    await writeAudit(db, {
      actorType: 'staff',
      actorId: staff.id,
      actorLabel: staff.full_name,
      action: 'auth.locked_out',
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: { reason, attempts },
    });
    return { status: 'locked', until: rows[0]!.locked_until };
  }
  await db.query(`UPDATE staff SET failed_login_count = $2 WHERE id = $1`, [staff.id, attempts]);
  await writeAudit(db, {
    actorType: 'staff',
    actorId: staff.id,
    actorLabel: staff.full_name,
    action: 'auth.login_failed',
    ip: meta.ip,
    userAgent: meta.userAgent,
    details: { reason, attempts },
  });
  return { status: 'invalid' };
}

export async function createSession(db: Db, config: Config, staffId: string, meta: RequestMeta): Promise<string> {
  const { token, hash } = generateToken();
  await db.query(
    `INSERT INTO staff_sessions (staff_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, LEAST(now() + make_interval(hours => $5), now() + make_interval(mins => $6)))`,
    [staffId, hash, meta.ip ?? null, meta.userAgent ?? null, config.SESSION_ABSOLUTE_HOURS, config.SESSION_IDLE_MINUTES]
  );
  return token;
}

export async function login(
  db: Db,
  config: Config,
  email: string,
  password: string,
  totpCode: string | undefined,
  meta: RequestMeta
): Promise<LoginResult> {
  const { rows } = await db.query<StaffAuthRow>(
    `SELECT id, email, full_name, is_active, password_hash, totp_secret_enc,
            totp_enabled, failed_login_count, locked_until, temp_password_expires_at, must_change_password
     FROM staff WHERE email = $1`,
    [email]
  );
  const staff = rows[0];

  if (!staff || !staff.is_active || !staff.password_hash) {
    // Unknown/inactive account: identical response to a bad password.
    await writeAudit(db, {
      actorType: 'system',
      actorLabel: email,
      action: 'auth.login_failed',
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: { reason: 'unknown_or_inactive_account' },
    });
    return { status: 'invalid' };
  }

  if (staff.locked_until && staff.locked_until > new Date()) {
    return { status: 'locked', until: staff.locked_until };
  }

  const passwordOk = await argon2.verify(staff.password_hash, password);
  if (!passwordOk) {
    return recordFailure(db, config, staff, 'bad_password', meta);
  }
  /*
   * TEMPORARY PASSWORDS EXPIRE (2026-09-12, ruling 1): 72 hours from creation, or the first
   * successful sign-in, whichever comes first. An expired one is refused even when it is right,
   * and the admin has to mint a new account password. It is consumed in mfaVerify (first sign-in
   * always enrols MFA) and in login for an account that somehow already has MFA.
   */
  if (staff.must_change_password && staff.temp_password_expires_at && staff.temp_password_expires_at < new Date()) {
    return { status: 'temp_password_expired' };
  }

  if (!staff.totp_enabled) {
    // MFA is REQUIRED for staff: no full session until enrolled. The scoped
    // token can only drive /auth/mfa/setup + /auth/mfa/verify.
    await db.query(`UPDATE staff SET failed_login_count = 0 WHERE id = $1`, [staff.id]);
    await writeAudit(db, {
      actorType: 'staff',
      actorId: staff.id,
      actorLabel: staff.full_name,
      action: 'auth.login_mfa_setup_required',
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return {
      status: 'mfa_setup_required',
      setupToken: createScopedToken(config.APP_ENCRYPTION_KEY, staff.id, MFA_SETUP_PURPOSE, MFA_SETUP_TTL_SECONDS),
    };
  }

  if (!totpCode) {
    return { status: 'totp_required' };
  }

  const secret = decryptSecret(staff.totp_secret_enc!, config.APP_ENCRYPTION_KEY);
  const delta = totpFor(secret, staff.email).validate({ token: totpCode, window: 1 });
  if (delta === null) {
    return recordFailure(db, config, staff, 'bad_totp', meta);
  }

  await db.query(
    `UPDATE staff SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
    [staff.id]
  );
  const token = await createSession(db, config, staff.id, meta);
  await writeAudit(db, {
    actorType: 'staff',
    actorId: staff.id,
    actorLabel: staff.full_name,
    action: 'auth.login_success',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { status: 'ok', token, staffId: staff.id, mustChangePassword: Boolean(staff.must_change_password) };
}

/** Step 1 of enrollment: generate + store the (encrypted) secret, return provisioning info. */
export async function mfaSetup(db: Db, config: Config, setupToken: string): Promise<{ secret: string; otpauthUri: string }> {
  const staffId = verifyScopedToken(config.APP_ENCRYPTION_KEY, setupToken, MFA_SETUP_PURPOSE);
  if (!staffId) throw new AppError(401, 'invalid_setup_token', 'MFA setup token is invalid or expired.');

  const { rows } = await db.query<{ email: string; totp_enabled: boolean }>(
    `SELECT email, totp_enabled FROM staff WHERE id = $1 AND is_active`,
    [staffId]
  );
  const staff = rows[0];
  if (!staff) throw new AppError(401, 'invalid_setup_token', 'MFA setup token is invalid or expired.');
  if (staff.totp_enabled) throw new AppError(409, 'mfa_already_enabled', 'MFA is already enabled for this account.');

  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  await db.query(`UPDATE staff SET totp_secret_enc = $2 WHERE id = $1`, [
    staffId,
    encryptSecret(secret, config.APP_ENCRYPTION_KEY),
  ]);
  return { secret, otpauthUri: totpFor(secret, staff.email).toString() };
}

/** Step 2: prove the authenticator works, flip totp_enabled, hand out the first real session. */
export async function mfaVerify(
  db: Db,
  config: Config,
  setupToken: string,
  code: string,
  meta: RequestMeta
): Promise<{ token: string; mustChangePassword: boolean }> {
  const staffId = verifyScopedToken(config.APP_ENCRYPTION_KEY, setupToken, MFA_SETUP_PURPOSE);
  if (!staffId) throw new AppError(401, 'invalid_setup_token', 'MFA setup token is invalid or expired.');

  const { rows } = await db.query<{ email: string; full_name: string; totp_secret_enc: Buffer | null; totp_enabled: boolean }>(
    `SELECT email, full_name, totp_secret_enc, totp_enabled FROM staff WHERE id = $1 AND is_active`,
    [staffId]
  );
  const staff = rows[0];
  if (!staff || !staff.totp_secret_enc) {
    throw new AppError(400, 'mfa_setup_missing', 'Run MFA setup before verification.');
  }
  if (staff.totp_enabled) throw new AppError(409, 'mfa_already_enabled', 'MFA is already enabled for this account.');

  const secret = decryptSecret(staff.totp_secret_enc, config.APP_ENCRYPTION_KEY);
  const delta = totpFor(secret, staff.email).validate({ token: code, window: 1 });
  if (delta === null) throw new AppError(401, 'invalid_totp', 'Authenticator code did not match.');

  // First sign-in: MFA is on, and the temporary password is spent. must_change_password stays
  // true until /auth/password succeeds; the session can reach /auth/* and nothing else.
  await db.query(
    `UPDATE staff SET totp_enabled = true, last_login_at = now(),
            temp_password_expires_at = CASE WHEN must_change_password THEN now() ELSE temp_password_expires_at END
      WHERE id = $1`, [staffId]);
  await writeAudit(db, {
    actorType: 'staff',
    actorId: staffId,
    actorLabel: staff.full_name,
    action: 'auth.mfa_enrolled',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  const owes = await db.query<{ must_change_password: boolean }>(`SELECT must_change_password FROM staff WHERE id = $1`, [staffId]);
  const token = await createSession(db, config, staffId, meta);
  return { token, mustChangePassword: Boolean(owes.rows[0]?.must_change_password) };
}

export async function logout(db: Db, sessionId: string, staffId: string, actorLabel: string, meta: RequestMeta): Promise<void> {
  await db.query(`UPDATE staff_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
  await writeAudit(db, {
    actorType: 'staff',
    actorId: staffId,
    actorLabel: actorLabel,
    action: 'auth.logout',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

export async function changePassword(
  db: Db,
  config: Config,
  staffId: string,
  actorLabel: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId: string,
  meta: RequestMeta
): Promise<void> {
  const { rows } = await db.query<{ password_hash: string | null }>(
    `SELECT password_hash FROM staff WHERE id = $1 AND is_active`,
    [staffId]
  );
  const hash = rows[0]?.password_hash;
  if (!hash || !(await argon2.verify(hash, currentPassword))) {
    throw new AppError(401, 'invalid_password', 'Current password is incorrect.');
  }
  await db.query(`UPDATE staff SET password_hash = $2 , must_change_password = false, temp_password_expires_at = NULL WHERE id = $1`, [staffId, await argon2.hash(newPassword)]);
  // Revoke every other session — a changed password invalidates old logins.
  await db.query(
    `UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [staffId, keepSessionId]
  );
  await writeAudit(db, {
    actorType: 'staff',
    actorId: staffId,
    actorLabel: actorLabel,
    action: 'auth.password_changed',
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}
