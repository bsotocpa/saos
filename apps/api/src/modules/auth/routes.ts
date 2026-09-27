import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { STAFF_SESSION_COOKIE, clearCookieOptions, staffCookieOptions } from '../../cookies.ts';
import * as auth from './service.ts';
import { holds } from '../../plugins/auth.ts';
import { homeFor } from './home.ts';

const LoginBody = z.object({
  email: z.email(),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/).optional(),
  /**
   * A recovery code in place of the authenticator code (R65). Its own field on the API: the sign-in
   * page decides by shape (six digits is a TOTP; letters and digits with a hyphen is a recovery
   * code) and sends one or the other, never both.
   */
  recoveryCode: z.string().trim().min(8).max(12).optional(),
}).refine((b) => !(b.totp && b.recoveryCode), { message: 'Send the authenticator code or a recovery code, not both.' });

const MfaSetupBody = z.object({ setupToken: z.string().min(1) });
const MfaVerifyBody = z.object({ setupToken: z.string().min(1), code: z.string().regex(/^\d{6}$/) });
/** A new recovery-code set needs the authenticator in hand: a current code, not just the session. */
const RecoveryCodesBody = z.object({ code: z.string().regex(/^\d{6}$/) });
const PasswordBody = z.object({
  currentPassword: z.string().min(1),
  // WISP: staff passwords are one factor of two — still keep them real.
  newPassword: z.string().min(12, 'New password must be at least 12 characters.'),
});

function meta(request: FastifyRequest) {
  return { ip: request.ip, userAgent: request.headers['user-agent'] ?? null };
}

export function registerAuthRoutes(app: FastifyInstance): void {
  // The browser app authenticates via this httpOnly cookie (M21 hardening);
  // the token also returns in the body for programmatic clients/tests, which
  // never persist it in page-readable storage.
  const setSessionCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(STAFF_SESSION_COOKIE, token, staffCookieOptions(app.config));

  app.post('/auth/login', async (request, reply) => {
    const body = LoginBody.parse(request.body);
    const result = await auth.login(app.db, app.config, body.email, body.password, body.totp, body.recoveryCode, meta(request));
    switch (result.status) {
      case 'invalid':
        // One sentence for every wrong credential, so the screen has words and nothing is confirmed.
        return reply.code(401).send({ error: 'invalid_credentials', message: 'The email, password or code did not match.' });
      case 'locked':
        return reply.code(423).send({ error: 'account_locked', until: result.until.toISOString() });
      case 'totp_required':
        return reply.code(401).send({ error: 'totp_required' });
      case 'temp_password_expired':
        return reply.code(401).send({ error: 'temp_password_expired', message: 'That temporary password has expired (72 hours, or already used). Ask the CEO for a new one.' });
      case 'mfa_setup_required':
        return reply.code(200).send({ status: 'mfa_setup_required', setupToken: result.setupToken });
      case 'ok':
        setSessionCookie(reply, result.token);
        if (result.recoveryCodeUsed) {
          // The session is real; the CEO learns of it in the same request (R65).
          const who = await app.db.query<{ display_name: string }>(`SELECT display_name FROM staff WHERE id = $1`, [result.staffId]);
          await auth.raiseRecoveryCodeUsedAlert(app, { staffId: result.staffId, fullName: who.rows[0]?.display_name ?? body.email, ...result.recoveryCodeUsed });
        }
        return reply.code(200).send({ status: 'ok', token: result.token, mustChangePassword: result.mustChangePassword });
    }
  });

  app.post('/auth/mfa/setup', async (request) => {
    const body = MfaSetupBody.parse(request.body);
    return auth.mfaSetup(app.db, app.config, body.setupToken);
  });

  app.post('/auth/mfa/verify', async (request, reply) => {
    const body = MfaVerifyBody.parse(request.body);
    const { token, mustChangePassword, recoveryCodes } = await auth.mfaVerify(app.db, app.config, body.setupToken, body.code, meta(request));
    setSessionCookie(reply, token);
    // The recovery codes travel in this one response and nowhere else (R65).
    return { status: 'ok', token, mustChangePassword, recoveryCodes };
  });

  // A new recovery-code set from Account (R65): the old set is gone the moment this answers.
  app.post('/auth/mfa/recovery-codes', { preHandler: [app.authenticate] }, async (request) => {
    const body = RecoveryCodesBody.parse(request.body);
    const staff = request.staff!;
    const recoveryCodes = await auth.reissueRecoveryCodes(app.db, app.config, staff.id, staff.fullName, body.code, meta(request));
    return { status: 'ok', recoveryCodes };
  });

  app.post('/auth/logout', { preHandler: [app.authenticate] }, async (request, reply) => {
    const staff = request.staff!;
    await auth.logout(app.db, staff.sessionId, staff.id, staff.fullName, meta(request));
    reply.clearCookie(STAFF_SESSION_COOKIE, clearCookieOptions(app.config));
    return { status: 'ok' };
  });

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (request) => {
    const staff = request.staff!;
    return {
      id: staff.id,
      email: staff.email,
      fullName: staff.fullName,
      role: staff.roleKey,
      permissions: staff.permissions,
      // R64: the page this session lands on, decided here from what it holds (home.ts).
      home: homeFor((p) => holds(staff, p)),
      /*
       * The staff-control switches the page decides from (2026-09-20). The Ops client page already
       * decides who sees the Refund control from this session; whether the control is ON at all is
       * the server's setting, read here so the page never guesses it from a failed request.
       */
      switches: { opsRefundControl: app.switches.opsRefundControl, quoteBuilder: app.switches.quoteBuilder, returnStepper: app.switches.returnStepper },
    };
  });

  app.post('/auth/password', { preHandler: [app.authenticate] }, async (request) => {
    const body = PasswordBody.parse(request.body);
    const staff = request.staff!;
    await auth.changePassword(
      app.db,
      app.config,
      staff.id,
      staff.fullName,
      body.currentPassword,
      body.newPassword,
      staff.sessionId,
      meta(request)
    );
    return { status: 'ok' };
  });
}
