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
//   recovery code instead of TOTP . accepted once and consumed in the same statement
//                                   (R65, 2026-09-26); the CEO gets an alert task

import { randomInt } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import argon2 from 'argon2';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db.ts';
import { alertRecipientForRole, notifyOnce, ownerForRole } from '../../staffing.ts';
import { createTask } from '../tasks/service.ts';
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
  | {
      status: 'ok';
      token: string;
      staffId: string;
      mustChangePassword: boolean;
      /** Set when the second factor was a recovery code: the route raises the CEO's alert from it. */
      recoveryCodeUsed?: { codeId: string; remaining: number };
    };

/*
 * RECOVERY CODES (Brian, 2026-09-26, R65). Eight per set, minted at enrolment and shown once;
 * argon2-hashed in staff_mfa_recovery_codes like a password; each signs in once. The alphabet
 * leaves out 0/O, 1/I/L and U so a code read off paper cannot be mis-typed, and the shape
 * (XXXX-XXXX, letters and digits) is what tells a recovery code apart from a six-digit TOTP.
 */
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

function mintOneRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < 8; i++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Upper-cased, spaces and hyphens removed: what a person typed, in the form that was hashed. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** Replaces the whole set: the old codes, used or live, are gone the moment the new ones exist. */
async function mintRecoveryCodeSet(db: Db, staffId: string): Promise<string[]> {
  const codes: string[] = [];
  while (codes.length < RECOVERY_CODE_COUNT) codes.push(mintOneRecoveryCode());
  const hashes = await Promise.all(codes.map((c) => argon2.hash(normalizeRecoveryCode(c))));
  await db.query(`DELETE FROM staff_mfa_recovery_codes WHERE staff_id = $1`, [staffId]);
  for (const hash of hashes) {
    await db.query(`INSERT INTO staff_mfa_recovery_codes (staff_id, code_hash) VALUES ($1, $2)`, [staffId, hash]);
  }
  return codes;
}

/**
 * Finds the live code the person typed and consumes it in the same statement that accepts it:
 * the UPDATE's `used_at IS NULL` guard means two sign-ins racing on one code get one session.
 * Null when no live code matches.
 */
async function consumeRecoveryCode(db: Db, staffId: string, typed: string): Promise<{ codeId: string; remaining: number } | null> {
  const wanted = normalizeRecoveryCode(typed);
  if (!/^[A-Z2-9]{8}$/.test(wanted)) return null;
  const { rows } = await db.query<{ id: string; code_hash: string }>(
    `SELECT id, code_hash FROM staff_mfa_recovery_codes WHERE staff_id = $1 AND used_at IS NULL ORDER BY created_at, id`,
    [staffId]
  );
  for (const row of rows) {
    if (!(await argon2.verify(row.code_hash, wanted))) continue;
    const consumed = await db.query<{ id: string }>(
      `UPDATE staff_mfa_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
      [row.id]
    );
    if (consumed.rowCount === 0) return null; // raced: the other sign-in has it
    const left = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM staff_mfa_recovery_codes WHERE staff_id = $1 AND used_at IS NULL`, [staffId]);
    return { codeId: row.id, remaining: Number(left.rows[0]?.n ?? 0) };
  }
  return null;
}

interface StaffAuthRow {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  password_hash: string | null;
  totp_secret_enc: Buffer | null;
  totp_enabled: boolean;
  temp_password_expires_at?: Date | null;
  /** Computed in the SELECT against Postgres now(): one clock (lessons.md, two clocks, 2026-09-09 and 2026-09-12). */
  temp_password_expired?: boolean;
  must_change_password?: boolean;
  failed_login_count: number;
  locked_until: Date | null;
}

interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  /**
   * A SESSION MINTED BY A SCRIPT NAMES THE SCRIPT (2026-09-12, Brian). An action applied on a
   * ruling is not the person's tap; every audit row written under such a session carries
   * "<name> (<appliedBy>)", so "Brian Soto (ruled 2026-09-12, applied by script)" is what the
   * log says. Stored on the session as user_agent "script: <appliedBy>"; the auth plugin reads it.
   */
  appliedBy?: string | null;
}

export const SCRIPT_SESSION_PREFIX = 'script: ';

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
  /*
   * THE VALIDATOR on system-applied actions: on the box, a session with no browser behind it
   * (no user agent) is a script, and a script says what it is applying, or gets no session.
   * A browser always sends its user agent; the login route passes it through.
   */
  const label = meta.appliedBy?.trim();
  if (!label && !meta.userAgent && config.NODE_ENV === 'production') {
    throw new AppError(400, 'session_unlabelled', 'A session with no browser behind it is a script; say what it applies (appliedBy), so the audit log names it.');
  }
  const userAgent = label ? `${SCRIPT_SESSION_PREFIX}${label}` : meta.userAgent ?? null;
  await db.query(
    `INSERT INTO staff_sessions (staff_id, token_hash, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, LEAST(now() + make_interval(hours => $5), now() + make_interval(mins => $6)))`,
    [staffId, hash, meta.ip ?? null, userAgent, config.SESSION_ABSOLUTE_HOURS, config.SESSION_IDLE_MINUTES]
  );
  return token;
}

export async function login(
  db: Db,
  config: Config,
  email: string,
  password: string,
  totpCode: string | undefined,
  recoveryCode: string | undefined,
  meta: RequestMeta
): Promise<LoginResult> {
  const { rows } = await db.query<StaffAuthRow>(
    `SELECT id, email, full_name, is_active, password_hash, totp_secret_enc,
            totp_enabled, failed_login_count, locked_until, temp_password_expires_at, must_change_password,
            (temp_password_expires_at IS NOT NULL AND temp_password_expires_at < now()) AS temp_password_expired
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
  // Expiry is decided by the database clock that stamped it, never by comparing to this host's.
  if (staff.must_change_password && staff.temp_password_expired === true) {
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

  if (!totpCode && !recoveryCode) {
    return { status: 'totp_required' };
  }

  /*
   * THE SECOND FACTOR: the authenticator code, or a recovery code in its place (R65). A recovery
   * code is consumed by the statement that accepts it, so it never signs in twice; a wrong one
   * counts as a failed attempt like a wrong TOTP, so guessing runs into the same lockout.
   */
  let recoveryCodeUsed: { codeId: string; remaining: number } | undefined;
  if (totpCode) {
    const secret = decryptSecret(staff.totp_secret_enc!, config.APP_ENCRYPTION_KEY);
    const delta = totpFor(secret, staff.email).validate({ token: totpCode, window: 1 });
    if (delta === null) {
      return recordFailure(db, config, staff, 'bad_totp', meta);
    }
  } else {
    const consumed = await consumeRecoveryCode(db, staff.id, recoveryCode!);
    if (!consumed) {
      return recordFailure(db, config, staff, 'bad_recovery_code', meta);
    }
    recoveryCodeUsed = consumed;
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
    details: recoveryCodeUsed ? { second_factor: 'recovery_code' } : { second_factor: 'totp' },
  });
  if (recoveryCodeUsed) {
    // The event, never the code: which set it came from and how many are left.
    await writeAudit(db, {
      actorType: 'staff',
      actorId: staff.id,
      actorLabel: staff.full_name,
      action: 'auth.recovery_code_used',
      objectType: 'staff',
      objectId: staff.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      details: { codes_remaining: recoveryCodeUsed.remaining },
    });
  }
  return {
    status: 'ok',
    token,
    staffId: staff.id,
    mustChangePassword: Boolean(staff.must_change_password),
    ...(recoveryCodeUsed ? { recoveryCodeUsed } : {}),
  };
}

/**
 * A RECOVERY CODE WAS USED, SO THE CEO IS TOLD (R65). Someone signed in without their
 * authenticator: either the member lost the phone (Reset MFA and re-enrol) or the codes leaked.
 * One task per use, owned by the CEO, plus the Ops alert. The task and the alert name the person
 * and the count left; never the code.
 */
export async function raiseRecoveryCodeUsedAlert(
  app: FastifyInstance,
  used: { staffId: string; fullName: string; codeId: string; remaining: number }
): Promise<void> {
  const owner = await ownerForRole(app.db, 'ceo');
  const task = await createTask(app, {
    title: `${used.fullName} signed in with an MFA recovery code`,
    description:
      `${used.fullName} used one of their single-use MFA recovery codes instead of their authenticator; ` +
      `${used.remaining} of the set remain. Ask them why. If the phone is gone, Reset MFA on their row in Staff so they enrol again ` +
      `at next sign-in; if they did not do this, reset it now and issue a new password.`,
    assignedStaffId: owner,
    priority: 2,
    source: 'system',
    sourceType: 'mfa_recovery_used',
    sourceId: used.codeId,
  });
  const recipient = await alertRecipientForRole(app.db, 'ceo', 'mfa_recovery_used');
  if (recipient) {
    await notifyOnce(app.db, {
      staffId: recipient,
      type: 'mfa_recovery_used',
      severity: 'critical',
      title: `${used.fullName} signed in with an MFA recovery code (${used.remaining} left)`,
      relatedObjectType: 'task',
      relatedObjectId: task.id,
    });
  }
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
): Promise<{ token: string; mustChangePassword: boolean; recoveryCodes: string[] }> {
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
  // The recovery codes, minted with the enrolment and shown once on the enrolment screen (R65).
  const recoveryCodes = await mintRecoveryCodeSet(db, staffId);
  await writeAudit(db, {
    actorType: 'staff',
    actorId: staffId,
    actorLabel: staff.full_name,
    action: 'auth.recovery_codes_issued',
    objectType: 'staff',
    objectId: staffId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    details: { count: recoveryCodes.length, on: 'enrolment' },
  });
  const owes = await db.query<{ must_change_password: boolean }>(`SELECT must_change_password FROM staff WHERE id = $1`, [staffId]);
  const token = await createSession(db, config, staffId, meta);
  return { token, mustChangePassword: Boolean(owes.rows[0]?.must_change_password), recoveryCodes };
}

/**
 * A NEW SET FROM ACCOUNT (R65): the signed-in member proves the authenticator is in hand with a
 * current code, and the old set, used or live, is replaced whole. Audited; the codes are returned
 * once and never again.
 */
export async function reissueRecoveryCodes(
  db: Db,
  config: Config,
  staffId: string,
  actorLabel: string,
  code: string,
  meta: RequestMeta
): Promise<string[]> {
  const { rows } = await db.query<{ email: string; totp_secret_enc: Buffer | null; totp_enabled: boolean }>(
    `SELECT email, totp_secret_enc, totp_enabled FROM staff WHERE id = $1 AND is_active`,
    [staffId]
  );
  const staff = rows[0];
  if (!staff || !staff.totp_enabled || !staff.totp_secret_enc) {
    throw new AppError(409, 'mfa_not_enabled', 'Enrol MFA before issuing recovery codes.');
  }
  const secret = decryptSecret(staff.totp_secret_enc, config.APP_ENCRYPTION_KEY);
  if (totpFor(secret, staff.email).validate({ token: code, window: 1 }) === null) {
    throw new AppError(401, 'invalid_totp', 'Authenticator code did not match.');
  }
  const codes = await mintRecoveryCodeSet(db, staffId);
  await writeAudit(db, {
    actorType: 'staff',
    actorId: staffId,
    actorLabel,
    action: 'auth.recovery_codes_issued',
    objectType: 'staff',
    objectId: staffId,
    ip: meta.ip,
    userAgent: meta.userAgent,
    details: { count: codes.length, on: 'reissue' },
  });
  return codes;
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
