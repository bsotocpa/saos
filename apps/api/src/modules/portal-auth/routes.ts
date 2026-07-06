import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../../plugins/auth.ts';
import { writeAudit } from '../../audit.ts';
import { ensurePortalUser, handleMailBounce, issueMagicLink, verifyMagicLink } from './service.ts';

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
    }
    return { status: 'ok', message: 'If that address has portal access, a sign-in link is on its way.' };
  });

  // Public: redeem the link.
  app.post('/portal/auth/magic/verify', async (request) => {
    const body = VerifyBody.parse(request.body);
    const result = await verifyMagicLink(app, body.token, {
      ip: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });
    return { status: 'ok', token: result.sessionToken, firstLogin: result.firstLogin };
  });

  app.post('/portal/auth/logout', { preHandler: [app.authenticateClient] }, async (request) => {
    const client = request.client!;
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

  // Staff: grant portal access to a contact (creates the account + sends the
  // first magic link). Rene's role carries magic_links.manage.
  app.post(
    '/portal-users',
    { preHandler: [app.authenticate, requirePermission('magic_links.manage')] },
    async (request, reply) => {
      const body = GrantAccessBody.parse(request.body);
      const actor = request.staff!;
      const user = await ensurePortalUser(app, body.contactId);
      await issueMagicLink(app, user.id);
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
