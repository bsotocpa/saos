// Client portal session authentication. Clients see ONLY their own records
// (MP Portal Auth): request.client.contactId is the single scoping key every
// portal query must filter by — never an id supplied by the client.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashToken } from '../crypto.ts';
import { PORTAL_SESSION_COOKIE } from '../cookies.ts';
import type { AuthedClient } from '../types.ts';

interface PortalSessionRow {
  session_id: string;
  portal_user_id: string;
  contact_id: string;
  email: string;
  language: 'en' | 'es';
}

export function buildAuthenticateClient(app: FastifyInstance) {
  return async function authenticateClient(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Portal pages carry the session in an httpOnly cookie (M21); the Bearer
    // header remains for programmatic clients and tests.
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ')
      ? header.slice(7)
      : request.cookies[PORTAL_SESSION_COOKIE];
    if (!token) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const { rows } = await app.db.query<PortalSessionRow>(
      `SELECT s.id AS session_id, u.id AS portal_user_id, u.contact_id, u.email, c.language
       FROM portal_sessions s
       JOIN portal_users u ON u.id = s.portal_user_id
       JOIN contacts c     ON c.id = u.contact_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND u.is_active
         AND NOT c.is_archived`,
      [hashToken(token)]
    );
    const row = rows[0];
    if (!row) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const client: AuthedClient = {
      portalUserId: row.portal_user_id,
      contactId: row.contact_id,
      email: row.email,
      language: row.language,
      sessionId: row.session_id,
    };
    request.client = client;
  };
}
