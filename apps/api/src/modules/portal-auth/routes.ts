import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { PORTAL_SESSION_COOKIE, clearCookieOptions, portalCookieOptions } from '../../cookies.ts';
import {
  ensurePortalUser,
  handleMailBounce,
  issueMagicLink,
  recordUnknownSignInAttempt,
  verifyMagicLink,
} from './service.ts';

const RequestLinkBody = z.object({ email: z.email() });
const VerifyBody = z.object({ token: z.string().min(1) });
const GrantAccessBody = z.object({ contactId: z.uuid() });
const DeliveryEventBody = z.object({
  recipient: z.email(),
  event: z.enum(['bounce', 'complaint', 'delivered']),
});

function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function registerPortalAuthRoutes(app: FastifyInstance): void {
  // Public: request a sign-in link. ALWAYS 200 — no account enumeration.
  app.post('/portal/auth/magic/request', async (request) => {
    const body = RequestLinkBody.parse(request.body);
    const { rows } = await app.db.query<{ id: string }>(
      `SELECT id FROM portal_users WHERE email = $1 AND is_active`,
      [body.email]
    );
    if (rows[0]) {
      await issueMagicLink(app, rows[0].id);
    } else {
      /*
       * FINDING #21 — the silent half.
       *
       * Brian asked for a sign-in link using his base address while his portal account
       * was on a plus-addressed one. The response said a link was on its way; nothing
       * was sent, because that address had no account. That behaviour is CORRECT — the
       * vague answer is what stops this endpoint confirming who is a client — but it
       * left a real person at the door with no way to tell "sent" from "you have no
       * account", and left nobody on our side aware of it.
       *
       * So the client-facing answer does not change by a word. The system just stops
       * being the only party that doesn't know.
       *
       * A task only when the address belongs to a CONTACT WE KNOW. That is the
       * actionable case — someone we have a relationship with cannot get in — and it
       * cannot be used to flood the queue, because producing one requires already
       * knowing a real client's address. An unrecognised address is a log line.
       */
      await recordUnknownSignInAttempt(app, body.email);
    }
    return { status: 'ok', message: 'If that address has portal access, a sign-in link is on its way.' };
  });

  // Public: redeem the link. The browser session rides in an httpOnly cookie
  // (M21); the body token remains for programmatic clients/tests.
  app.post('/portal/auth/magic/verify', async (request, reply) => {
    const body = VerifyBody.parse(request.body);
    const result = await verifyMagicLink(app, body.token, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    reply.setCookie(PORTAL_SESSION_COOKIE, result.sessionToken, portalCookieOptions(app.config));
    return { status: 'ok', token: result.sessionToken, firstLogin: result.firstLogin };
  });

  app.post('/portal/auth/logout', { preHandler: [app.authenticateClient] }, async (request, reply) => {
    const client = request.client!;
    reply.clearCookie(PORTAL_SESSION_COOKIE, clearCookieOptions(app.config));
    await app.db.query(`UPDATE portal_sessions SET revoked_at = now() WHERE id = $1`, [client.sessionId]);
    await writeAudit(app.db, {
      actorType: 'client',
      actorId: client.portalUserId,
      actorLabel: client.email,
      action: 'portal.logout',
      contactId: client.contactId,
    });
    return { status: 'ok' };
  });

  /**
   * Sign out EVERYWHERE (Brian's #13 ruling, 2026-08-15).
   *
   * Sessions now last 30 days and slide with use, which is right for a client on their
   * own phone and wrong for a borrowed or shared device. This is the answer to that: one
   * action that ends every session this client has anywhere, not just the browser they
   * happen to be holding.
   *
   * Revoking rather than deleting — the rows are the record of where a client was signed
   * in, and a client asking "sign me out everywhere" is exactly when that record starts
   * mattering.
   */
  app.post('/portal/auth/logout-all', { preHandler: [app.authenticateClient] }, async (request, reply) => {
    const client = request.client!;
    const { rowCount } = await app.db.query(
      `UPDATE portal_sessions
          SET revoked_at = now()
        WHERE portal_user_id = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [client.portalUserId]
    );
    reply.clearCookie(PORTAL_SESSION_COOKIE, clearCookieOptions(app.config));
    await writeAudit(app.db, {
      actorType: 'client',
      actorId: client.portalUserId,
      actorLabel: client.email,
      action: 'portal.logout_all',
      contactId: client.contactId,
      details: { sessions_revoked: rowCount ?? 0 },
      ip: request.ip,
    });
    return { status: 'ok', sessionsRevoked: rowCount ?? 0 };
  });

  // Staff: grant portal access to a contact (creates the account + sends the
  // first magic link). Rene's role carries magic_links.manage.
  app.post(
    '/portal-users',
    { preHandler: [app.authenticate, requirePermission('magic_links.manage')] },
    async (request, reply) => {
      const body = GrantAccessBody.parse(request.body);
      const actor = request.staff!;
      const user = await ensurePortalUser(app, body.contactId);
      // A brand-new account gets the INVITE; an existing one gets the plain sign-in
      // link, because by then they know what the portal is (finding #21).
      await issueMagicLink(app, user.id, { purpose: user.created ? 'invite' : 'login' });
      if (user.created) {
        await writeAudit(app.db, {
          actorType: 'staff',
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'portal_user.created',
          objectType: 'portal_user',
          objectId: user.id,
          contactId: body.contactId,
        });
      }
      return reply.code(user.created ? 201 : 200).send({ id: user.id, created: user.created });
    }
  );

  // Delivery-status webhook (mail relay → us). Bounce = Rene fallback task.
  // Authenticated by shared secret header; the SES/SNS adapter (M23) will
  // translate provider payloads into this neutral shape.
  app.post('/webhooks/mail/delivery', async (request, reply) => {
    const secret = request.headers['x-webhook-secret'];
    if (typeof secret !== 'string' || !secretsMatch(secret, app.config.WEBHOOK_SECRET)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = DeliveryEventBody.parse(request.body);
    if (body.event === 'bounce' || body.event === 'complaint') {
      const { matched } = await handleMailBounce(app, body.recipient);
      return { status: 'ok', matched };
    }
    return { status: 'ok' };
  });
}
