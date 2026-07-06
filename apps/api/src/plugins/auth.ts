// Session authentication + RBAC (MP: role-based least privilege, session
// timeout). Sessions are opaque bearer tokens; only their SHA-256 hash is
// stored. Expiry slides with activity (idle window) but never past the
// absolute lifetime set at login.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashToken } from '../crypto.ts';
import { STAFF_SESSION_COOKIE } from '../cookies.ts';
import type { AuthedStaff } from '../types.ts';

interface SessionRow {
  session_id: string;
  staff_id: string;
  email: string;
  full_name: string;
  role_key: string;
  permissions: string[];
}

export function buildAuthenticate(app: FastifyInstance) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Browser apps carry the session in an httpOnly cookie (M21); the Bearer
    // header remains for programmatic clients and tests.
    const header = request.headers.authorization;
    const token = header?.startsWith('Bearer ')
      ? header.slice(7)
      : request.cookies[STAFF_SESSION_COOKIE];
    if (!token) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    const { rows } = await app.db.query<SessionRow>(
      `SELECT s.id AS session_id, st.id AS staff_id, st.email, st.full_name, r.key AS role_key,
              COALESCE(array_agg(rp.permission) FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
       FROM staff_sessions s
       JOIN staff st ON st.id = s.staff_id
       JOIN roles r  ON r.id = st.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND st.is_active
       GROUP BY s.id, st.id, r.key`,
      [hashToken(token)]
    );
    const row = rows[0];
    if (!row) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }

    // Sliding expiry: extend by the idle window, capped at the absolute lifetime.
    await app.db.query(
      `UPDATE staff_sessions
       SET expires_at = LEAST(created_at + make_interval(hours => $2), now() + make_interval(mins => $3))
       WHERE id = $1`,
      [row.session_id, app.config.SESSION_ABSOLUTE_HOURS, app.config.SESSION_IDLE_MINUTES]
    );

    const staff: AuthedStaff = {
      id: row.staff_id,
      email: row.email,
      fullName: row.full_name,
      roleKey: row.role_key,
      permissions: row.permissions,
      sessionId: row.session_id,
    };
    request.staff = staff;
  };
}

/** RBAC guard. '*' (Brian, Jackson) grants everything; everyone else needs the named permission. */
export function requirePermission(permission: string) {
  return async function check(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const staff = request.staff;
    if (!staff) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    if (!staff.permissions.includes('*') && !staff.permissions.includes(permission)) {
      await reply.code(403).send({ error: 'forbidden', permission });
      return;
    }
  };
}
