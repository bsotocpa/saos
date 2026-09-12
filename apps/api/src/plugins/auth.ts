// Session authentication + RBAC (MP: role-based least privilege, session
// timeout). Sessions are opaque bearer tokens; only their SHA-256 hash is
// stored. Expiry slides with activity (idle window) but never past the
// absolute lifetime set at login.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../types.ts';
import { hashToken } from '../crypto.ts';
import { STAFF_SESSION_COOKIE } from '../cookies.ts';
import type { AuthedStaff } from '../types.ts';

interface SessionRow {
  session_id: string;
  staff_id: string;
  email: string;
  full_name: string; must_change_password: boolean;
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
      `SELECT s.id AS session_id, st.id AS staff_id, st.email, st.display_name AS full_name, st.must_change_password, r.key AS role_key,
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
    /*
     * A SESSION THAT STILL OWES A PASSWORD (2026-09-12, ruling 1). The temporary password was
     * spent on sign-in; until the person sets their own, the session reaches /auth/* only.
     */
    if (row.must_change_password && !request.url.startsWith('/auth/')) {
      throw new AppError(403, 'password_change_required', 'Set your own password before doing anything else (Account → Password).');
    }
    request.staff = staff;
  };
}

/**
 * Permissions the wildcard does NOT confer — they must be granted by name.
 *
 * '*' exists so Brian and Jackson don't need every key enumerated, and that is
 * right for operational access. It is wrong for narrow authority over money: a
 * role holding '*' should not silently acquire the power to waive a deposit
 * because someone added a feature. `deposits.override` is seeded to the CEO role
 * alone, and Jackson's '*' does not reach it — which is exactly what Brian asked
 * for ("seed it to me only") and would otherwise have been impossible to express.
 *
 * Keep this set small and financial. Anything added here needs an explicit grant
 * in the roles seed, or nobody can do it at all.
 */
export const EXPLICIT_ONLY_PERMISSIONS: ReadonlySet<string> = new Set(['deposits.override']);

/**
 * RBAC guard. '*' (Brian, Jackson) grants everything EXCEPT the explicit-only
 * permissions above; everyone else needs the named permission.
 */
export function requirePermission(permission: string) {
  return async function check(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const staff = request.staff;
    if (!staff) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const wildcardApplies =
      staff.permissions.includes('*') && !EXPLICIT_ONLY_PERMISSIONS.has(permission);
    if (!wildcardApplies && !staff.permissions.includes(permission)) {
      await reply.code(403).send({ error: 'forbidden', permission });
      return;
    }
  };
}
