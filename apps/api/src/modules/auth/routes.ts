import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { STAFF_SESSION_COOKIE, clearCookieOptions, staffCookieOptions } from '../../cookies.ts';
import * as auth from './service.ts';

const LoginBody = z.object({
  email: z.email(),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

const MfaSetupBody = z.object({ setupToken: z.string().min(1) });
const MfaVerifyBody = z.object({ setupToken: z.string().min(1), code: z.string().regex(/^\d{6}$/) });
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
    const result = await auth.login(app.db, app.config, body.email, body.password, body.totp, meta(request));
    switch (result.status) {
      case 'invalid':
        return reply.code(401).send({ error: 'invalid_credentials' });
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
        return reply.code(200).send({ status: 'ok', token: result.token, mustChangePassword: result.mustChangePassword });
    }
  });

  app.post('/auth/mfa/setup', async (request) => {
    const body = MfaSetupBody.parse(request.body);
    return auth.mfaSetup(app.db, app.config, body.setupToken);
  });

  app.post('/auth/mfa/verify', async (request, reply) => {
    const body = MfaVerifyBody.parse(request.body);
    const { token, mustChangePassword } = await auth.mfaVerify(app.db, app.config, body.setupToken, body.code, meta(request));
    setSessionCookie(reply, token);
    return { status: 'ok', token, mustChangePassword };
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
